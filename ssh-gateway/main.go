// Command ssh-gateway serves Git over SSH for yuma-agent-git (issue #34,
// docs/ssh.md, ADR 0007). Configuration comes from the environment:
//
//	YAG_FORGE_URL            the forge's internal hostname (https://…), required
//	YAG_SSH_GATEWAY_KEY      the gateway key the forge expects, required
//	YAG_SSH_HOST_KEY_FILE    the host private key (OpenSSH or PEM), or
//	YAG_SSH_HOST_KEY         the same key's contents
//	YAG_SSH_LISTEN           listen address, default :2222
//	CF_ACCESS_CLIENT_ID      optional Cloudflare Access service token for
//	CF_ACCESS_CLIENT_SECRET  the internal hostname
//
// `ssh-gateway -fingerprint` prints the host key fingerprint and exits.
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

func main() {
	printFingerprint := flag.Bool("fingerprint", false, "print the host key fingerprint and exit")
	flag.Parse()
	logger := log.New(os.Stderr, "ssh-gateway: ", log.LstdFlags)

	hostKey, err := loadHostKey(os.Getenv)
	if err != nil {
		logger.Fatal(err)
	}
	fingerprint := hostKey.PublicKey().Type() + " " + ssh.FingerprintSHA256(hostKey.PublicKey())
	if *printFingerprint {
		fmt.Println(fingerprint)
		return
	}
	forge, err := forgeFromEnv(os.Getenv)
	if err != nil {
		logger.Fatal(err)
	}
	listen := os.Getenv("YAG_SSH_LISTEN")
	if listen == "" {
		listen = ":2222"
	}
	l, err := net.Listen("tcp", listen)
	if err != nil {
		logger.Fatal(err)
	}
	logger.Printf("listening on %s, host key %s, forge %s", l.Addr(), fingerprint, forge.BaseURL)
	logger.Fatal(NewGateway(forge, hostKey, logger).Serve(l))
}

func loadHostKey(getenv func(string) string) (ssh.Signer, error) {
	pem := []byte(getenv("YAG_SSH_HOST_KEY"))
	if path := getenv("YAG_SSH_HOST_KEY_FILE"); path != "" {
		var err error
		if pem, err = os.ReadFile(path); err != nil {
			return nil, fmt.Errorf("reading the host key: %w", err)
		}
	}
	if len(pem) == 0 {
		return nil, errors.New("set YAG_SSH_HOST_KEY_FILE or YAG_SSH_HOST_KEY")
	}
	signer, err := ssh.ParsePrivateKey(pem)
	if err != nil {
		return nil, fmt.Errorf("reading the host key: %w", err)
	}
	return signer, nil
}

func forgeFromEnv(getenv func(string) string) (*Forge, error) {
	base := strings.TrimSuffix(getenv("YAG_FORGE_URL"), "/")
	u, err := url.Parse(base)
	if base == "" || err != nil || u.Host == "" {
		return nil, errors.New("set YAG_FORGE_URL to the forge's internal hostname")
	}
	// plain HTTP only to this machine, for local development
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return nil, errors.New("YAG_FORGE_URL must use https")
	}
	key := getenv("YAG_SSH_GATEWAY_KEY")
	if key == "" {
		return nil, errors.New("set YAG_SSH_GATEWAY_KEY")
	}
	return &Forge{
		BaseURL:      base,
		GatewayKey:   key,
		AccessID:     getenv("CF_ACCESS_CLIENT_ID"),
		AccessSecret: getenv("CF_ACCESS_CLIENT_SECRET"),
		Client:       &http.Client{Timeout: 10 * time.Minute},
	}, nil
}
