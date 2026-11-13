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
