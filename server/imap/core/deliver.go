package factory

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"imap/internal/dedupe"
	"imap/internal/directorykind"
	"imap/internal/filing"
)

var (
	ErrNotIMAPUser = errors.New("not an IMAP user: unknown, or IMAP is not enabled")
	ErrInFlight    = errors.New("the same message is being delivered right now, try again shortly")
)

func (cf *ConnectorFactory) SetFilingRules(fn func() filing.Rules) {
	cf.mu.Lock()
	defer cf.mu.Unlock()
	cf.rules = fn
}

func (cf *ConnectorFactory) Accepts(address string) bool {
	cf.mu.Lock()
	defer cf.mu.Unlock()
	return cf.connectors[directorykind.Normalize(address)] != nil
}

func (cf *ConnectorFactory) Deliver(ctx context.Context, address, mailbox string, literal []byte) (string, error) {
	cf.mu.Lock()
	conn := cf.connectors[directorykind.Normalize(address)]
	rules := cf.rules
	cf.mu.Unlock()
	if conn == nil {
		return "", ErrNotIMAPUser
	}

	account := directorykind.Normalize(address)
	messageID := dedupe.MessageID(literal)

	outcome, existing, err := cf.seen.Claim(ctx, account, messageID)
	tracked := err == nil && messageID != ""
	switch {
	case err != nil:
		log.Printf("delivery: duplicate check failed for %s, storing the message anyway: %v", account, err)
	case outcome == dedupe.Duplicate:
		log.Printf("delivery: %s already has %s, not storing it again", account, messageID)
		return existing, nil
	case outcome == dedupe.InFlight:
		log.Printf("delivery: %s is already receiving %s, asking the sender to retry", account, messageID)
		return "", ErrInFlight
	}
	stored := false
	if tracked {
		defer func() {
			if stored {
				return
			}
			if err := cf.seen.Release(context.WithoutCancel(ctx), account, messageID); err != nil {
				log.Printf("delivery: could not release the claim on %s for %s: %v", messageID, account, err)
			}
		}()
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
			log.Printf("delivery: %s -> %s (%s)", account, mailbox, d.Reason)
		}
	}

	id, err := conn.Deliver(ctx, mailbox, literal, nil, time.Now())
	if err != nil {
		return "", err
	}
	stored = true
	if tracked {
		if err := cf.seen.Complete(context.WithoutCancel(ctx), account, messageID, id); err != nil {
			log.Printf("delivery: could not record %s for %s: %v", messageID, account, err)
		}
	}
	return id, nil
}
