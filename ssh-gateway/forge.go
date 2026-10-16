package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Forge calls the Worker: the authorise endpoint on its internal hostname,
// and smart HTTP with the short-lived token that endpoint returns. The only
// credential it holds is the gateway key (and, when configured, a Cloudflare
// Access service token for the internal hostname).
type Forge struct {
	BaseURL      string // the internal hostname, e.g. https://ssh-gateway.internal.example
	GatewayKey   string
	AccessID     string
	AccessSecret string
	Client       *http.Client
}

// forgeError is a refusal from the forge, shown to the Git user.
type forgeError struct {
	Status  int
	Code    string
	Message string
}

func (e *forgeError) Error() string { return e.Message }

func (f *Forge) do(req *http.Request) (*http.Response, error) {
	req.Header.Set("User-Agent", "yag-ssh-gateway")
	if f.AccessID != "" {
		req.Header.Set("CF-Access-Client-Id", f.AccessID)
		req.Header.Set("CF-Access-Client-Secret", f.AccessSecret)
	}
	res, err := f.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("the forge is unreachable: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		defer res.Body.Close()
		return nil, refusal(res)
	}
	return res, nil
}

func refusal(res *http.Response) error {
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	_ = json.Unmarshal(raw, &body)
	e := &forgeError{Status: res.StatusCode, Code: body.Error.Code, Message: body.Error.Message}
	if e.Message == "" {
		e.Message = fmt.Sprintf("the forge answered %s", res.Status)
	}
	return e
}

// authorize asks for a token for one repo and service. With repo and service
// empty it only checks that the key is registered and returns no token.
func (f *Forge) authorize(ctx context.Context, fingerprint, repo, service string) (string, time.Time, error) {
	input := map[string]string{"fingerprint": fingerprint}
	if repo != "" {
		input["repo"] = repo
		input["service"] = service
	}
	body, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		f.BaseURL+"/internal/ssh/authorize", bytes.NewReader(body))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ssh-Gateway-Key", f.GatewayKey)
	res, err := f.do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer res.Body.Close()
	var out struct {
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expires_at"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&out); err != nil {
		return "", time.Time{}, fmt.Errorf("unreadable answer from the forge: %w", err)
	}
	if repo != "" && out.Token == "" {
		return "", time.Time{}, fmt.Errorf("the forge returned no token")
	}
	return out.Token, time.UnixMilli(out.ExpiresAt), nil
}

// git makes one smart HTTP request for `repo` with a token. A non-200
// answer comes back as a *forgeError.
func (f *Forge) git(ctx context.Context, method, repo, path, token, protocol, contentType string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, f.BaseURL+"/"+repo+".git/"+path, body)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth("git", token)
	if protocol != "" {
		req.Header.Set("Git-Protocol", protocol)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("Accept", strings.Replace(contentType, "-request", "-result", 1))
	}
	return f.do(req)
}

// tokenSource holds the current token for one SSH command and asks for a new
// one when it is about to expire, so a long fetch keeps working.
type tokenSource struct {
	forge                      *Forge
	fingerprint, repo, service string
	token                      string
	expires                    time.Time
}

func (t *tokenSource) get(ctx context.Context) (string, error) {
	if t.token != "" && time.Until(t.expires) > 10*time.Second {
		return t.token, nil
	}
	token, expires, err := t.forge.authorize(ctx, t.fingerprint, t.repo, t.service)
	if err != nil {
		return "", err
	}
	t.token, t.expires = token, expires
	return token, nil
}
