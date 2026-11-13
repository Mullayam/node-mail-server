package filing

import (
	"bufio"
	"bytes"
	"fmt"
	"net/textproto"
	"strings"
)

type Rules struct {
	SpamMailbox string
	SpamHeaders []string
}

type Decision struct {
	Mailbox string
	Spam    bool
	Reason  string
}

func Decide(literal []byte, r Rules) Decision {
	inbox := Decision{Mailbox: "INBOX"}
	if r.SpamMailbox == "" || strings.EqualFold(r.SpamMailbox, "INBOX") {
		return inbox
	}

	hdr, _ := textproto.NewReader(bufio.NewReader(bytes.NewReader(literal))).ReadMIMEHeader()
	for _, name := range r.SpamHeaders {
		for _, v := range hdr.Values(name) {
			if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(v)), "YES") {
				return Decision{
					Mailbox: r.SpamMailbox,
					Spam:    true,
					Reason:  fmt.Sprintf("%s: %s", name, strings.TrimSpace(v)),
				}
			}
		}
	}
	return inbox
}

const OutboxHeader = "X-AE-Outbox"

type OutboxStage string

const (
	NotOutbox    OutboxStage = ""
	OutboxQueued OutboxStage = "queued"
	OutboxSent   OutboxStage = "sent"
)

func Outbox(literal []byte) OutboxStage {
	hdr, _ := textproto.NewReader(bufio.NewReader(bytes.NewReader(literal))).ReadMIMEHeader()
	switch OutboxStage(strings.ToLower(strings.TrimSpace(hdr.Get(OutboxHeader)))) {
	case OutboxQueued:
		return OutboxQueued
	case OutboxSent:
		return OutboxSent
	}
	return NotOutbox
}

func StripHeader(literal []byte, name string) []byte {
	prefix := strings.ToLower(name) + ":"
	out := make([]byte, 0, len(literal))
	rest := literal
	skipping := false
	for len(rest) > 0 {
		line := rest
		if i := bytes.IndexByte(rest, '\n'); i >= 0 {
			line, rest = rest[:i+1], rest[i+1:]
		} else {
			rest = nil
		}
		if len(bytes.TrimRight(line, "\r\n")) == 0 {
			out = append(out, line...)
			return append(out, rest...)
		}
		if skipping && (line[0] == ' ' || line[0] == '\t') {
			continue
		}
		skipping = strings.HasPrefix(strings.ToLower(string(line)), prefix)
		if !skipping {
			out = append(out, line...)
		}
	}
	return out
}
