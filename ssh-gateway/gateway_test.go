package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

const testGatewayKey = "test-gateway-key"

// fakeForge stands in for the Worker: the authorise endpoint with the
// gateway key, and smart HTTP that takes only the tokens it minted, served
// by `git http-backend` when Git is installed.
type fakeForge struct {
	gitBin  string
	root    string
	ttl     time.Duration
	mu      sync.Mutex
	keys    map[string]bool // fingerprint → read-only
	tokens  map[string]minted
	issued  int
	leaked  bool     // the gateway key reached a Git endpoint
	headers []string // Git-Protocol on upload-pack requests
}

type minted struct {
	repo, service string
	expires       time.Time
}

func (f *fakeForge) addKey(key ssh.PublicKey, readOnly bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.keys[ssh.FingerprintSHA256(key)] = readOnly
}

func (f *fakeForge) setTTL(ttl time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ttl = ttl
}

func refuse(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func (f *fakeForge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.URL.Path == "/internal/ssh/authorize" {
		f.authorize(w, r)
		return
	}
	if r.Header.Get("X-Ssh-Gateway-Key") != "" {
		f.leaked = true
	}
	service := r.URL.Query().Get("service")
	if !strings.HasSuffix(r.URL.Path, "/info/refs") {
		service = r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	}
	repo := strings.TrimPrefix(r.URL.Path[:strings.Index(r.URL.Path, ".git/")], "/")
	_, pass, _ := r.BasicAuth()
	tok, ok := f.tokens[pass]
	if !ok || tok.service != service || tok.repo != repo || time.Now().After(tok.expires) {
		refuse(w, 401, "unauthorized", "authentication required")
		return
	}
	if service == uploadPack {
		f.headers = append(f.headers, r.Header.Get("Git-Protocol"))
	}
	if f.gitBin == "" {
		refuse(w, 500, "no_git", "no git binary")
		return
	}
	f.mu.Unlock()
	defer f.mu.Lock()
	// Go's CGI host refuses chunked bodies, which the gateway streams pushes
	// as (the Worker takes them); buffer them for http-backend here.
	if r.ContentLength < 0 && r.Body != nil {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			refuse(w, 400, "bad_body", err.Error())
			return
		}
		r.Body, r.ContentLength, r.TransferEncoding = io.NopCloser(bytes.NewReader(body)), int64(len(body)), nil
	}
	(&cgi.Handler{
		Path: f.gitBin,
		Args: []string{"http-backend"},
		Env:  []string{"GIT_PROJECT_ROOT=" + f.root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "HOME=" + f.root},
	}).ServeHTTP(w, r)
}

func (f *fakeForge) authorize(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-Ssh-Gateway-Key") != testGatewayKey {
		refuse(w, 401, "unauthorized", "gateway key required")
		return
	}
	var in struct{ Fingerprint, Repo, Service string }
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		refuse(w, 400, "invalid_request", "bad json")
		return
	}
	readOnly, known := f.keys[in.Fingerprint]
	switch {
	case !known:
		refuse(w, 403, "unknown_key", "this key is not registered")
	case in.Repo == "":
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	case in.Repo != "demo/fixture":
		refuse(w, 404, "repo_not_found", "no repo "+in.Repo)
	case in.Service == receivePack && readOnly:
		refuse(w, 403, "deploy_key_read_only", "this deploy key is read-only")
	default:
		f.issued++
		token := fmt.Sprintf("yag_ssh_test_%d", f.issued)
		expires := time.Now().Add(f.ttl)
		f.tokens[token] = minted{repo: in.Repo, service: in.Service, expires: expires}
		_ = json.NewEncoder(w).Encode(map[string]any{"token": token, "expires_at": expires.UnixMilli()})
	}
}

type harness struct {
	forge   *fakeForge
	addr    string
	hostKey ssh.PublicKey
	forgeL  string
}

func newKey(t *testing.T) (ssh.Signer, ed25519.PrivateKey) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return signer, priv
}

func start(t *testing.T) *harness {
	t.Helper()
	gitBin, _ := exec.LookPath("git")
	f := &fakeForge{
		gitBin: gitBin, root: t.TempDir(), ttl: 60 * time.Second,
		keys: map[string]bool{}, tokens: map[string]minted{},
	}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	host, _ := newKey(t)
	forge := &Forge{BaseURL: srv.URL, GatewayKey: testGatewayKey, Client: srv.Client()}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go NewGateway(forge, host, log.New(io.Discard, "", 0)).Serve(l)
	return &harness{forge: f, addr: l.Addr().String(), hostKey: host.PublicKey(), forgeL: srv.Listener.Addr().String()}
}

func (h *harness) dial(signers ...ssh.Signer) (*ssh.Client, error) {
	return ssh.Dial("tcp", h.addr, &ssh.ClientConfig{
		User:            "git",
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signers...)},
		HostKeyCallback: ssh.FixedHostKey(h.hostKey),
		Timeout:         5 * time.Second,
	})
}

func (h *harness) client(t *testing.T, signer ssh.Signer) *ssh.Client {
	t.Helper()
	c, err := h.dial(signer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func session(t *testing.T, c *ssh.Client) *ssh.Session {
	t.Helper()
	s, err := c.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestRefusesUnregisteredKeys(t *testing.T) {
	h := start(t)
	stranger, _ := newKey(t)
	if _, err := h.dial(stranger); err == nil {
		t.Fatal("an unregistered key signed in")
	}
	// a client tries its next key, as OpenSSH does
	known, _ := newKey(t)
	h.forge.addKey(known.PublicKey(), false)
	c, err := h.dial(stranger, known)
	if err != nil {
		t.Fatalf("the registered second key was refused: %v", err)
	}
	c.Close()
}

func TestRefusesShellsPtysAndOtherCommands(t *testing.T) {
	h := start(t)
	key, _ := newKey(t)
	h.forge.addKey(key.PublicKey(), false)
	c := h.client(t, key)

	if err := session(t, c).RequestPty("xterm", 40, 80, ssh.TerminalModes{}); err == nil {
		t.Error("pty granted")
	}
	if err := session(t, c).Shell(); err == nil {
		t.Error("shell started")
	}
	if err := session(t, c).RequestSubsystem("sftp"); err == nil {
		t.Error("sftp subsystem started")
	}
	if err := session(t, c).Setenv("LD_PRELOAD", "/tmp/x.so"); err == nil {
		t.Error("environment other than GIT_PROTOCOL accepted")
	}
	for _, command := range []string{"ls -la", "git-upload-archive 'demo/fixture.git'", "sh -c id"} {
		s := session(t, c)
		var stderr bytes.Buffer
		s.Stderr = &stderr
		if err := s.Run(command); err == nil {
			t.Errorf("%q ran", command)
		}
	}
	// port forwarding both ways
	if _, err := c.Dial("tcp", h.forgeL); err == nil {
		t.Error("direct-tcpip to the forge opened")
	}
	if l, err := c.Listen("tcp", "127.0.0.1:0"); err == nil {
		l.Close()
		t.Error("remote port forwarding granted")
	}
}

func run(t *testing.T, c *ssh.Client, protocol, command string) (stdout, stderr string, err error) {
	t.Helper()
	s := session(t, c)
	if protocol != "" {
		if err := s.Setenv("GIT_PROTOCOL", protocol); err != nil {
			t.Fatal(err)
		}
	}
	var out, errOut bytes.Buffer
	s.Stdout, s.Stderr = &out, &errOut
	s.Stdin = strings.NewReader("0000")
	err = s.Run(command)
	return out.String(), errOut.String(), err
}

func exitStatus(err error) int {
	var exit *ssh.ExitError
	if errors.As(err, &exit) {
		return exit.ExitStatus()
	}
	return -1
}

func TestUploadPackNeedsProtocolV2(t *testing.T) {
	h := start(t)
	key, _ := newKey(t)
	h.forge.addKey(key.PublicKey(), false)
	stdout, _, err := run(t, h.client(t, key), "", "git-upload-pack 'demo/fixture.git'")
	if !strings.HasPrefix(stdout[4:], "ERR this server speaks Git protocol v2 only") || exitStatus(err) != 1 {
		t.Fatalf("stdout %q err %v", stdout, err)
	}
	if h.forge.issued != 0 {
		t.Fatal("a token was minted for a refused command")
	}
}

func TestForgeRefusalsReachTheGitUser(t *testing.T) {
	h := start(t)
	key, _ := newKey(t)
	h.forge.addKey(key.PublicKey(), true)
	c := h.client(t, key)
	_, stderr, err := run(t, c, "", "git-receive-pack 'demo/fixture.git'")
	if !strings.Contains(stderr, "ERROR: this deploy key is read-only") || exitStatus(err) != 1 {
		t.Fatalf("stderr %q err %v", stderr, err)
	}
	_, stderr, err = run(t, c, "version=2", "git-upload-pack 'demo/missing.git'")
	if !strings.Contains(stderr, "ERROR: no repo demo/missing") || exitStatus(err) != 1 {
		t.Fatalf("stderr %q err %v", stderr, err)
	}
}

func TestTokensAreRefreshedBeforeTheyExpire(t *testing.T) {
	h := start(t)
	key, _ := newKey(t)
	h.forge.addKey(key.PublicKey(), false)
	h.forge.setTTL(5 * time.Second) // inside the 10-second margin
	srcForge := &Forge{BaseURL: "http://" + h.forgeL, GatewayKey: testGatewayKey, Client: http.DefaultClient}
	src := &tokenSource{forge: srcForge, fingerprint: ssh.FingerprintSHA256(key.PublicKey()), repo: "demo/fixture", service: uploadPack}
	first, err := src.get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, _ := src.get(context.Background())
	if first == second {
		t.Fatal("an expiring token was reused")
	}
	h.forge.setTTL(60 * time.Second)
	third, _ := src.get(context.Background())
	fourth, _ := src.get(context.Background())
	if third != fourth {
		t.Fatal("a fresh token was not reused")
	}
}

// TestGitOverSSH clones, fetches and pushes with the real git and ssh
// binaries through the gateway to `git http-backend`.
func TestGitOverSSH(t *testing.T) {
	sshBin, err := exec.LookPath("ssh")
	h := start(t)
	if h.forge.gitBin == "" || err != nil {
		t.Skip("needs git and ssh")
	}
	tmp := t.TempDir()
	writer, writerKey := newKey(t)
	reader, readerKey := newKey(t)
	h.forge.addKey(writer.PublicKey(), false)
	h.forge.addKey(reader.PublicKey(), true) // a read-only deploy key

	_, port, _ := net.SplitHostPort(h.addr)
	sshCommand := func(priv ed25519.PrivateKey, name string) string {
		block, err := ssh.MarshalPrivateKey(priv, "")
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(tmp, name)
		if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprintf("%s -F /dev/null -p %s -i %s -o IdentitiesOnly=yes -o IdentityAgent=none "+
			"-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR",
			sshBin, port, path)
	}
	asWriter, asReader := sshCommand(writerKey, "writer"), sshCommand(readerKey, "reader")
	emptyConfig := filepath.Join(tmp, "gitconfig")
	_ = os.WriteFile(emptyConfig, nil, 0o600)
	git := func(dir, sshCmd string, args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, h.forge.gitBin, args...)
		cmd.Dir = dir
		for _, kv := range os.Environ() {
			if !strings.HasPrefix(kv, "GIT_") && !strings.HasPrefix(kv, "SSH_") {
				cmd.Env = append(cmd.Env, kv)
			}
		}
		cmd.Env = append(cmd.Env, "HOME="+tmp, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+emptyConfig,
			"GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND="+sshCmd,
			"GIT_AUTHOR_NAME=Ada", "GIT_AUTHOR_EMAIL=ada@example.com",
			"GIT_COMMITTER_NAME=Ada", "GIT_COMMITTER_EMAIL=ada@example.com")
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	must := func(dir, sshCmd string, args ...string) string {
		t.Helper()
		out, err := git(dir, sshCmd, args...)
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return out
	}
	const remote = "git@127.0.0.1:demo/fixture.git"
	bare := filepath.Join(h.forge.root, "demo", "fixture.git")
	must(tmp, "", "init", "-q", "--bare", "-b", "main", bare)
	must(bare, "", "config", "http.receivepack", "true")

	work := filepath.Join(tmp, "work")
	must(tmp, "", "init", "-q", "-b", "main", work)
	_ = os.WriteFile(filepath.Join(work, "README.md"), []byte("over ssh\n"), 0o644)
	must(work, "", "add", "README.md")
	must(work, "", "commit", "-q", "-m", "first")
	must(work, asWriter, "push", "-q", remote, "main")

	clone := filepath.Join(tmp, "clone")
	must(tmp, asReader, "clone", "-q", remote, clone)
	if got, _ := os.ReadFile(filepath.Join(clone, "README.md")); string(got) != "over ssh\n" {
		t.Fatalf("cloned README %q", got)
	}

	// a second commit: a push with refs to compare, and a fetch with haves
	_ = os.WriteFile(filepath.Join(work, "README.md"), []byte("again\n"), 0o644)
	must(work, "", "commit", "-q", "-am", "second")
	must(work, asWriter, "push", "-q", remote, "main")
	must(clone, asReader, "pull", "-q", "--ff-only")
	if got, _ := os.ReadFile(filepath.Join(clone, "README.md")); string(got) != "again\n" {
		t.Fatalf("pulled README %q", got)
	}

	// a delete sends no pack and keeps its input open for the report
	must(work, asWriter, "push", "-q", remote, "main:refs/heads/topic")
	must(work, asWriter, "push", "-q", remote, "--delete", "topic")
	if out, _ := git(bare, "", "show-ref"); strings.Contains(out, "topic") {
		t.Fatalf("topic not deleted:\n%s", out)
	}

	// the read-only key never writes
	out, err := git(clone, asReader, "push", remote, "main:refs/heads/nope")
	if err == nil || !strings.Contains(out, "read-only") {
		t.Fatalf("read-only push: %v\n%s", err, out)
	}

	h.forge.mu.Lock()
	defer h.forge.mu.Unlock()
	if h.forge.leaked {
		t.Error("the gateway key was sent to a Git endpoint")
	}
	for _, p := range h.forge.headers {
		if p != "version=2" {
			t.Errorf("upload-pack request with Git-Protocol %q", p)
		}
	}
	if len(h.forge.headers) == 0 {
		t.Error("no upload-pack requests reached the forge")
	}
}
