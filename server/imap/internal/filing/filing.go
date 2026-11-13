// Package filing decides which mailbox incoming mail goes to.
//
// The spam decision itself is made upstream: the mail server (Node) runs the
// SPF, DKIM, DMARC and other checks and marks suspicious mail with a header
// such as "X-AE-Spam-Flag: YES". A content filter like Rspamd or
// SpamAssassin would add "X-Spam-Flag: YES" in the same way. Delivery only
// reads those headers and files the message, which is how Postfix, Rspamd and
// Dovecot split the work too.
package filing

import (
	"bufio"
	"bytes"
	"fmt"
	"net/textproto"
	"strings"
)

// Rules come from <delivery> in imap.xml.
type Rules struct {
	SpamMailbox string   // where spam goes, for example "Junk"
	SpamHeaders []string // headers that mark spam when their value starts with YES
}

// Decision is where a message goes, and why.
type Decision struct {
	Mailbox string
	Spam    bool
	Reason  string // for logs, for example "X-AE-Spam-Flag: YES"
}

// Decide reads the message headers and picks the mailbox.
func Decide(literal []byte, r Rules) Decision {
	inbox := Decision{Mailbox: "INBOX"}
	if r.SpamMailbox == "" || strings.EqualFold(r.SpamMailbox, "INBOX") {
		return inbox
	}
	// A broken header block still returns the headers read so far.
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
