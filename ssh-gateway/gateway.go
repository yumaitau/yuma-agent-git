package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// Gateway is the SSH front end for Git (issue #34). It accepts a public key
// only when the forge says it is registered, runs only git-upload-pack and
// git-receive-pack, and speaks smart HTTP to the forge with a token that
// covers that one repository and service for 60 seconds. Shells, ptys,
// subsystems and port forwarding are refused.
type Gateway struct {
	forge  *Forge
	config *ssh.ServerConfig
	log    *log.Logger
}

const handshakeTimeout = 30 * time.Second

func NewGateway(forge *Forge, hostKey ssh.Signer, logger *log.Logger) *Gateway {
	g := &Gateway{forge: forge, log: logger}
	g.config = &ssh.ServerConfig{
		PublicKeyCallback: g.checkKey,
		ServerVersion:     "SSH-2.0-yag-ssh-gateway",
	}
	g.config.AddHostKey(hostKey)
	return g
}

// checkKey runs before the client proves it holds the key; the ssh package
// checks that proof afterwards and keeps the permissions of the key that
// passed, so the fingerprint read from them is the authenticated one.
func (g *Gateway) checkKey(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
	fp := ssh.FingerprintSHA256(key)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, _, err := g.forge.authorize(ctx, fp, "", ""); err != nil {
		return nil, fmt.Errorf("key %s refused: %w", fp, err)
	}
	return &ssh.Permissions{Extensions: map[string]string{"fingerprint": fp}}, nil
}

// Serve accepts connections until the listener closes.
func (g *Gateway) Serve(l net.Listener) error {
	for {
		conn, err := l.Accept()
		if err != nil {
			return err
		}
		go g.handleConn(conn)
	}
}

func (g *Gateway) handleConn(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(handshakeTimeout))
	sconn, chans, reqs, err := ssh.NewServerConn(conn, g.config)
	if err != nil {
		g.log.Printf("handshake from %s failed: %v", conn.RemoteAddr(), err)
		return
	}
	_ = conn.SetDeadline(time.Time{})
	defer sconn.Close()
	// global requests (tcpip-forward and the like) are all refused
	go ssh.DiscardRequests(reqs)
	fp := sconn.Permissions.Extensions["fingerprint"]
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.Prohibited, "only Git commands are supported")
			continue
		}
		ch, chReqs, err := nc.Accept()
		if err != nil {
			continue
		}
		go g.session(ch, chReqs, fp)
	}
}

func (g *Gateway) session(ch ssh.Channel, reqs <-chan *ssh.Request, fp string) {
	defer ch.Close()
	protocol := ""
	for req := range reqs {
		switch req.Type {
		case "env":
			var kv struct{ Name, Value string }
			ok := ssh.Unmarshal(req.Payload, &kv) == nil && kv.Name == "GIT_PROTOCOL"
			if ok {
				protocol = kv.Value
			}
			_ = req.Reply(ok, nil)
		case "exec":
			var cmd struct{ Command string }
			service, repo, err := "", "", ssh.Unmarshal(req.Payload, &cmd)
			if err == nil {
				service, repo, err = parseCommand(cmd.Command)
			}
			if err != nil {
				_ = req.Reply(false, nil)
				fail(ch, err)
				return
			}
			_ = req.Reply(true, nil)
			finish(ch, g.run(ch, fp, service, repo, protocol))
			return
		case "shell", "subsystem":
			_ = req.Reply(false, nil)
			fail(ch, errCommand)
			return
		default: // pty-req, x11-req, agent forwarding, signals …
			if req.WantReply {
				_ = req.Reply(false, nil)
			}
		}
	}
}

// fail tells the client why and ends the command with status 1.
func fail(ch ssh.Channel, err error) {
	fmt.Fprintf(ch.Stderr(), "ERROR: %s\n", err)
	finish(ch, 1)
}

func finish(ch ssh.Channel, status uint32) {
	_ = ch.CloseWrite()
	_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
}

func (g *Gateway) run(ch ssh.Channel, fp, service, repo, protocol string) uint32 {
	ctx := context.Background()
	tokens := &tokenSource{forge: g.forge, fingerprint: fp, repo: repo, service: service}
	var err error
	if service == uploadPack {
		err = g.uploadPack(ctx, ch, tokens, protocol)
	} else {
		err = g.receivePack(ctx, ch, tokens)
	}
	if err != nil {
		g.log.Printf("%s %s %s: %v", fp, service, repo, err)
		fmt.Fprintf(ch.Stderr(), "ERROR: %s\n", err)
		return 1
	}
	g.log.Printf("%s %s %s: ok", fp, service, repo)
	return 0
}

const v2Only = "this server speaks Git protocol v2 only; run git -c protocol.version=2 (the default since Git 2.26)"

// uploadPack serves a fetch or clone. Protocol v2 is stateless: each
// command the client sends (up to a flush) is one POST.
func (g *Gateway) uploadPack(ctx context.Context, ch ssh.Channel, tokens *tokenSource, protocol string) error {
	if !strings.Contains(":"+protocol+":", ":version=2:") {
		// Git prints this as "remote error: …"
		_, _ = ch.Write(pktLine("ERR " + v2Only + "\n"))
		return errors.New(v2Only)
	}
	token, err := tokens.get(ctx)
	if err != nil {
		return err
	}
	res, err := g.forge.git(ctx, "GET", tokens.repo, "info/refs?service="+uploadPack, token, protocol, "", nil)
	if err != nil {
		return err
	}
	err = copyAdvert(ch, res.Body)
	res.Body.Close()
	if err != nil {
		return err
	}
	in := bufio.NewReader(ch)
	for {
		request, err := readRequest(in)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if len(request) == 4 { // a lone flush: the client is done
			return nil
		}
		if token, err = tokens.get(ctx); err != nil {
			return err
		}
		res, err := g.forge.git(ctx, "POST", tokens.repo, uploadPack, token, protocol,
			"application/x-git-upload-pack-request", bytes.NewReader(request))
		if err != nil {
			return err
		}
		_, err = io.Copy(ch, res.Body)
		res.Body.Close()
		if err != nil {
			return err
		}
	}
}

// receivePack serves a push: the advertisement, then one POST of the
// commands, any push options and the pack, streamed as the client sends it.
func (g *Gateway) receivePack(ctx context.Context, ch ssh.Channel, tokens *tokenSource) error {
	token, err := tokens.get(ctx)
	if err != nil {
		return err
	}
	res, err := g.forge.git(ctx, "GET", tokens.repo, "info/refs?service="+receivePack, token, "", "", nil)
	if err != nil {
		return err
	}
	err = copyAdvert(ch, res.Body)
	res.Body.Close()
	if err != nil {
		return err
	}
	in := bufio.NewReader(ch)
	commands, err := readRequest(in)
	if err == io.EOF || len(commands) == 4 { // nothing to update
		return nil
	}
	if err != nil {
		return err
	}
	needsPack, pushOptions := pushShape(commands)
	if pushOptions {
		options, err := readRequest(in)
		if err != nil {
			return fmt.Errorf("reading push options: %w", err)
		}
		commands = append(commands, options...)
	}
	// A pack runs to the end of the client's input. Deletes send none and
	// keep the channel open for the report, so nothing more is read.
	body := io.Reader(bytes.NewReader(commands))
	if needsPack {
		body = io.MultiReader(body, in)
	}
	if token, err = tokens.get(ctx); err != nil {
		return err
	}
	res, err = g.forge.git(ctx, "POST", tokens.repo, receivePack, token, "",
		"application/x-git-receive-pack-request", body)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, err = io.Copy(ch, res.Body)
	return err
}
