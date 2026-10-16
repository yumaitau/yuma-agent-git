package main

import (
	"errors"
	"regexp"
	"strings"
)

const (
	uploadPack  = "git-upload-pack"
	receivePack = "git-receive-pack"
)

// A repository path segment as the forge allows it: no slashes, no leading dot.
var segment = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`)

var errCommand = errors.New("this server only runs git-upload-pack and git-receive-pack; there is no shell")

// parseCommand reads the command Git asks the server to run, such as
// `git-upload-pack 'owner/repo.git'`, and returns the service and `owner/repo`.
// Everything else is refused.
func parseCommand(command string) (service, repo string, err error) {
	name, arg, ok := strings.Cut(strings.TrimSpace(command), " ")
	if !ok || (name != uploadPack && name != receivePack) {
		return "", "", errCommand
	}
	path, err := unquote(strings.TrimSpace(arg))
	if err != nil {
		return "", "", err
	}
	path = strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(path, "/"), "/"), ".git")
	owner, name2, ok := strings.Cut(path, "/")
	if !ok || !segment.MatchString(owner) || !segment.MatchString(name2) {
		return "", "", errors.New("expected a repository path like owner/repo.git")
	}
	return name, owner + "/" + name2, nil
}

// unquote undoes Git's shell quoting (sq_quote_buf): the path in single
// quotes, with any quote or ! inside it closed off and written as \' or \!
// between quoted parts. Unquoted paths pass through.
func unquote(arg string) (string, error) {
	if !strings.HasPrefix(arg, "'") {
		if strings.ContainsAny(arg, "'\"\\ \t\n") {
			return "", errors.New("malformed repository path")
		}
		return arg, nil
	}
	var out strings.Builder
	rest := arg
	for rest != "" {
		if !strings.HasPrefix(rest, "'") {
			return "", errors.New("malformed repository path")
		}
		end := strings.Index(rest[1:], "'")
		if end < 0 {
			return "", errors.New("malformed repository path")
		}
		out.WriteString(rest[1 : 1+end])
		rest = rest[2+end:]
		// between quoted parts Git writes \' or \!
		if strings.HasPrefix(rest, `\'`) || strings.HasPrefix(rest, `\!`) {
			out.WriteByte(rest[1])
			rest = rest[2:]
		} else if rest != "" {
			return "", errors.New("malformed repository path")
		}
	}
	return out.String(), nil
}
