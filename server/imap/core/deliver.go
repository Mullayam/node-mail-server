package factory

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"imap/internal/directorykind"
	"imap/internal/filing"
)

// ErrNotIMAPUser is returned by Deliver for an account that is not loaded in
// Gluon: it does not exist, or IMAP is not enabled for it.
var ErrNotIMAPUser = errors.New("not an IMAP user: unknown, or IMAP is not enabled")

// SetFilingRules tells Deliver where to put spam. fn is called for every
// message, so a reload of imap.xml applies at once.
func (cf *ConnectorFactory) SetFilingRules(fn func() filing.Rules) {
	cf.mu.Lock()
	defer cf.mu.Unlock()
	cf.rules = fn
}

// Accepts reports whether address has a mailbox: the user exists and IMAP is
// enabled, so the user is loaded in Gluon. The LMTP listener asks this for
// every RCPT TO.
func (cf *ConnectorFactory) Accepts(address string) bool {
	cf.mu.Lock()
	defer cf.mu.Unlock()
	return cf.connectors[directorykind.Normalize(address)] != nil
}

// Deliver puts a message into a user's mailbox from outside an IMAP session
// (SMTP delivery over LMTP, or the router's mail.deliver command). The message
// is stored, then announced to Gluon through the user's update stream, so
// connected clients see it straight away.
//
// An empty mailbox means "file it": INBOX, or the spam mailbox (created on
// first use) when a spam header such as X-AE-Spam-Flag says YES.
func (cf *ConnectorFactory) Deliver(ctx context.Context, address, mailbox string, literal []byte) (string, error) {
	cf.mu.Lock()
	conn := cf.connectors[directorykind.Normalize(address)]
	rules := cf.rules
	cf.mu.Unlock()
	if conn == nil {
		return "", ErrNotIMAPUser
	}

	if mailbox == "" {
		var d filing.Decision
		if rules != nil {
			d = filing.Decide(literal, rules())
		} else {
			d = filing.Decision{Mailbox: "INBOX"}
		}
		mailbox = d.Mailbox
		if d.Spam {
			m, err := conn.EnsureMailbox(ctx, d.Mailbox)
			if err != nil {
				return "", fmt.Errorf("prepare %s: %w", d.Mailbox, err)
			}
			mailbox = strings.Join(m.Name, "/")
			log.Printf("delivery: %s -> %s (%s)", directorykind.Normalize(address), mailbox, d.Reason)
		}
	}
	return conn.Deliver(ctx, mailbox, literal, nil, time.Now())
}
