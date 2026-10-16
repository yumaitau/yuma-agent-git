package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Git pkt-lines (gitprotocol-common): a 4-digit hex length that counts
// itself, then the payload; 0000 is a flush, 0001 a delimiter, 0002 the end
// of a response.
const maxPkt = 65520

// A v2 command request or a push's command list; the forge refuses bigger.
const maxRequest = 4 << 20

// readPkt returns one pkt-line as sent (header included) and its length
// field: 0, 1 and 2 are the special packets.
func readPkt(r io.Reader) ([]byte, int, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, 0, err
	}
	n, err := strconv.ParseUint(string(hdr[:]), 16, 16)
	if err != nil || n == 3 || n > maxPkt {
		return nil, 0, fmt.Errorf("malformed pkt-line length %q", hdr[:])
	}
	if n < 4 {
		return hdr[:], int(n), nil
	}
	buf := make([]byte, n)
	copy(buf, hdr[:])
	if _, err := io.ReadFull(r, buf[4:]); err != nil {
		return nil, 0, io.ErrUnexpectedEOF
	}
	return buf, int(n), nil
}

// readRequest reads pkt-lines up to and including a flush. io.EOF means the
// client closed before starting another request.
func readRequest(r io.Reader) ([]byte, error) {
	var out []byte
	for {
		pkt, n, err := readPkt(r)
		if err == io.EOF && out == nil {
			return nil, io.EOF
		}
		if err == io.EOF {
			return nil, io.ErrUnexpectedEOF
		}
		if err != nil {
			return nil, err
		}
		out = append(out, pkt...)
		if len(out) > maxRequest {
			return nil, errors.New("request too large")
		}
		if n == 0 {
			return out, nil
		}
	}
}

func pktLine(s string) []byte {
	return []byte(fmt.Sprintf("%04x%s", len(s)+4, s))
}

// copyAdvert copies a smart HTTP advertisement to an SSH client without the
// HTTP-only `# service=…` line and its flush, when present.
func copyAdvert(w io.Writer, r io.Reader) error {
	br := bufio.NewReader(r)
	first, _, err := readPkt(br)
	if err != nil {
		return fmt.Errorf("reading the advertisement: %w", err)
	}
	if bytes.HasPrefix(first[4:], []byte("# service=")) {
		if _, n, err := readPkt(br); err != nil || n != 0 {
			return errors.New("malformed advertisement")
		}
	} else if _, err := w.Write(first); err != nil {
		return err
	}
	_, err = io.Copy(w, br)
	return err
}

// pushShape reports whether a push's command list updates any ref to an
// object (a pack follows) and whether push options follow the commands.
func pushShape(commands []byte) (needsPack, pushOptions bool) {
	r := bytes.NewReader(commands)
	for first := true; ; first = false {
		pkt, n, err := readPkt(r)
		if err != nil || n < 4 {
			return
		}
		line := strings.TrimSuffix(string(pkt[4:]), "\n")
		line, caps, _ := strings.Cut(line, "\x00")
		if first {
			pushOptions = strings.Contains(" "+caps+" ", " push-options ")
		}
		fields := strings.Fields(line)
		if len(fields) == 3 && strings.Trim(fields[1], "0") != "" {
			needsPack = true
		}
	}
}
