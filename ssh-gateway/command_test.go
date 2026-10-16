package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseCommand(t *testing.T) {
	ok := []struct{ command, service, repo string }{
		{"git-upload-pack 'acme/tools.git'", uploadPack, "acme/tools"},
		{"git-receive-pack '/acme/tools.git'", receivePack, "acme/tools"},
		{"git-upload-pack '/acme/tools.git/'", uploadPack, "acme/tools"},
		{"git-upload-pack acme/tools", uploadPack, "acme/tools"},
		{"git-upload-pack 'acme/my.repo-1_x.git'", uploadPack, "acme/my.repo-1_x"},
	}
	for _, c := range ok {
		service, repo, err := parseCommand(c.command)
		if err != nil || service != c.service || repo != c.repo {
			t.Errorf("%q: got %q %q %v", c.command, service, repo, err)
		}
	}
	bad := []string{
		"",
		"ls -la",
		"sh -c 'id'",
		"git-upload-archive 'acme/tools.git'",
		"git upload-pack 'acme/tools.git'",
		"git-upload-pack",
		"git-upload-pack 'acme/tools.git",
		"git-upload-pack 'acme'",
		"git-upload-pack 'acme/tools/extra.git'",
		"git-upload-pack '../etc/passwd'",
		"git-upload-pack 'acme/..'",
		"git-upload-pack 'acme/.hidden'",
		"git-upload-pack 'acme/tools.git'; rm -rf /",
		"git-upload-pack 'acme/x'\\''y.git'",
	}
	for _, command := range bad {
		if _, _, err := parseCommand(command); err == nil {
			t.Errorf("%q: accepted", command)
		}
	}
}

func TestUnquote(t *testing.T) {
	got, err := unquote(`'a'\''b'\!'c'`)
	if err != nil || got != "a'b!c" {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestPushShape(t *testing.T) {
	zero := strings.Repeat("0", 40)
	one := strings.Repeat("1", 40)
	cmds := func(lines ...string) []byte {
		var b bytes.Buffer
		for _, l := range lines {
			b.Write(pktLine(l))
		}
		b.WriteString("0000")
		return b.Bytes()
	}
	needsPack, options := pushShape(cmds(zero + " " + one + " refs/heads/main\x00report-status push-options\n"))
	if !needsPack || !options {
		t.Fatalf("create: pack %v options %v", needsPack, options)
	}
	needsPack, options = pushShape(cmds(one + " " + zero + " refs/heads/old\x00report-status delete-refs\n"))
	if needsPack || options {
		t.Fatalf("delete: pack %v options %v", needsPack, options)
	}
}

func TestCopyAdvertDropsTheServiceLine(t *testing.T) {
	var in bytes.Buffer
	in.Write(pktLine("# service=git-receive-pack\n"))
	in.WriteString("0000")
	in.Write(pktLine("abc refs/heads/main\n"))
	in.WriteString("0000")
	var out bytes.Buffer
	if err := copyAdvert(&out, &in); err != nil {
		t.Fatal(err)
	}
	if want := string(pktLine("abc refs/heads/main\n")) + "0000"; out.String() != want {
		t.Fatalf("got %q", out.String())
	}
	// a v2 advertisement has no service line and passes through whole
	v2 := string(pktLine("version 2\n")) + "0000"
	out.Reset()
	if err := copyAdvert(&out, strings.NewReader(v2)); err != nil || out.String() != v2 {
		t.Fatalf("got %q %v", out.String(), err)
	}
}
