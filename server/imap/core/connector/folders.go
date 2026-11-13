package connector

import (
	"context"
	"fmt"
	"log"
	"slices"
	"strings"
	"time"

	"github.com/ProtonMail/gluon/imap"

	"imap/internal/storage"
)

const (
	OutboxName  = "Outbox"
	SentName    = "Sent"
	ArchiveName = "Archive"
)

func splitName(name string) []string {
	var parts []string
	for _, p := range strings.Split(name, "/") {
		if p = strings.TrimSpace(p); p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}

func roleOf(name []string) string {
	if attrs := specialUse(name).ToSlice(); len(attrs) > 0 {
		return attrs[0]
	}
	return ""
}

func sameName(a, b []string) bool {
	return slices.EqualFunc(a, b, strings.EqualFold)
}

func (c *MyDBConnector) index() storage.MessageIndex {
	ix, _ := c.engine.(storage.MessageIndex)
	return ix
}

func (c *MyDBConnector) findMailbox(ctx context.Context, name string) (storage.Mailbox, bool, error) {
	parts := splitName(name)
	mboxes, err := c.engine.ListMailboxes(ctx, c.email)
	if err != nil {
		return storage.Mailbox{}, false, err
	}
	for _, m := range mboxes {
		if sameName(m.Name, parts) {
			return m, true, nil
		}
	}
	if role := roleOf(parts); role != "" {
		for _, m := range mboxes {
			if roleOf(m.Name) == role {
				return m, true, nil
			}
		}
	}
	return storage.Mailbox{}, false, nil
}

func (c *MyDBConnector) mailboxWithRole(ctx context.Context, role string) (storage.Mailbox, bool) {
	mboxes, err := c.engine.ListMailboxes(ctx, c.email)
	if err != nil {
		return storage.Mailbox{}, false
	}
	for _, m := range mboxes {
		if roleOf(m.Name) == role {
			return m, true
		}
	}
	return storage.Mailbox{}, false
}

func (c *MyDBConnector) EnsureMailbox(ctx context.Context, name string) (storage.Mailbox, error) {
	m, found, err := c.findMailbox(ctx, name)
	if err != nil || found {
		return m, err
	}
	parts := splitName(name)
	if len(parts) == 0 {
		return storage.Mailbox{}, fmt.Errorf("invalid mailbox name %q", name)
	}
	id, err := c.engine.CreateMailbox(ctx, c.email, parts)
	if err != nil {
		return storage.Mailbox{}, err
	}
	m = storage.Mailbox{ID: id, Name: parts}
	if err := c.push(ctx, imap.NewMailboxCreated(gluonMailbox(m))); err != nil {
		return storage.Mailbox{}, fmt.Errorf("announce mailbox %s: %w", name, err)
	}
	if roleOf(parts) == imap.AttrFlagged {
		c.backfillStarred(ctx, m)
	}
	return m, nil
}

func (c *MyDBConnector) EnsureDefaults(ctx context.Context, names []string) error {
	var failed []string
	for _, name := range names {
		if _, err := c.EnsureMailbox(ctx, name); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", name, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("default folders for %s: %s", c.email, strings.Join(failed, "; "))
	}
	return nil
}

func (c *MyDBConnector) isStarred(mboxID string) bool {
	m, ok := c.mailboxWithRole(context.Background(), imap.AttrFlagged)
	return ok && m.ID == mboxID
}

func toMailboxIDs(ids []string) []imap.MailboxID {
	out := make([]imap.MailboxID, len(ids))
	for i, id := range ids {
		out[i] = imap.MailboxID(id)
	}
	return out
}

func (c *MyDBConnector) pushLater(u imap.Update) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := c.push(ctx, u); err != nil {
			log.Printf("folders: update for %s not applied: %v", c.email, err)
		}
	}()
}

func (c *MyDBConnector) announceMembership(ctx context.Context, id string, later bool) {
	ix := c.index()
	if ix == nil {
		return
	}
	m, boxes, err := ix.Lookup(ctx, c.email, id)
	if err != nil {
		return
	}
	u := imap.NewMessageMailboxesUpdated(imap.MessageID(id), toMailboxIDs(boxes), imap.NewFlagSetFromSlice(m.Flags))
	if later {
		c.pushLater(u)
		return
	}
	if err := c.push(ctx, u); err != nil {
		log.Printf("folders: update for %s not applied: %v", c.email, err)
	}
}

func (c *MyDBConnector) announceFlags(ctx context.Context, ids []string) {
	ix := c.index()
	if ix == nil {
		return
	}
	for _, id := range ids {
		if m, _, err := ix.Lookup(ctx, c.email, id); err == nil {
			c.pushLater(imap.NewMessageFlagsUpdated(imap.MessageID(id), imap.NewFlagSetFromSlice(m.Flags)))
		}
	}
}

func (c *MyDBConnector) syncStarred(ctx context.Context, ids []string, flagged bool) {
	starred, ok := c.mailboxWithRole(ctx, imap.AttrFlagged)
	ix := c.index()
	if !ok || ix == nil {
		return
	}
	for _, id := range ids {
		_, boxes, err := ix.Lookup(ctx, c.email, id)
		if err != nil {
			continue
		}
		in := slices.Contains(boxes, starred.ID)
		switch {
		case flagged && !in:
			err = c.engine.AddToMailbox(ctx, c.email, []string{id}, starred.ID)
		case !flagged && in && len(boxes) > 1:
			err = c.engine.RemoveFromMailbox(ctx, c.email, []string{id}, starred.ID)
		case !flagged && in:
			target, found := c.mailboxWithRole(ctx, imap.AttrArchive)
			if !found {
				target, found = c.inbox(ctx)
			}
			if !found {
				continue
			}
			err = c.engine.MoveMessages(ctx, c.email, []string{id}, starred.ID, target.ID)
		default:
			continue
		}
		if err != nil {
			log.Printf("folders: starred %s for %s: %v", id, c.email, err)
			continue
		}
		c.announceMembership(ctx, id, true)
	}
}

func (c *MyDBConnector) inbox(ctx context.Context) (storage.Mailbox, bool) {
	mboxes, err := c.engine.ListMailboxes(ctx, c.email)
	if err != nil {
		return storage.Mailbox{}, false
	}
	i := slices.IndexFunc(mboxes, isInbox)
	if i < 0 {
		return storage.Mailbox{}, false
	}
	return mboxes[i], true
}

func (c *MyDBConnector) backfillStarred(ctx context.Context, starred storage.Mailbox) {
	mboxes, err := c.engine.ListMailboxes(ctx, c.email)
	if err != nil {
		return
	}
	seen := map[string]bool{}
	var flagged []string
	for _, m := range mboxes {
		if m.ID == starred.ID {
			continue
		}
		msgs, err := c.engine.ListMessages(ctx, c.email, m.ID)
		if err != nil {
			continue
		}
		for _, msg := range msgs {
			if !seen[msg.ID] && slices.ContainsFunc(msg.Flags, func(f string) bool { return strings.EqualFold(f, imap.FlagFlagged) }) {
				flagged = append(flagged, msg.ID)
			}
			seen[msg.ID] = true
		}
	}
	c.syncStarred(ctx, flagged, true)
}

func (c *MyDBConnector) removeCopy(ctx context.Context, id, mboxID string) error {
	ix := c.index()
	_, boxes, err := ix.Lookup(ctx, c.email, id)
	if err != nil {
		return err
	}
	if err := c.engine.RemoveFromMailbox(ctx, c.email, []string{id}, mboxID); err != nil {
		return err
	}
	if len(boxes) <= 1 {
		c.deleted(ctx, []string{id})
		return c.push(ctx, imap.NewMessagesDeleted(imap.MessageID(id)))
	}
	c.announceMembership(ctx, id, false)
	return nil
}

func (c *MyDBConnector) CompleteOutbox(ctx context.Context, literal []byte) (string, error) {
	sent, err := c.EnsureMailbox(ctx, SentName)
	if err != nil {
		return "", err
	}
	sentName := strings.Join(sent.Name, "/")
	ix := c.index()
	mid := storage.HeaderMessageID(literal)
	if ix == nil || mid == "" {
		return c.Deliver(ctx, sentName, literal, []string{imap.FlagSeen}, time.Now())
	}
	outbox, hasOutbox, err := c.findMailbox(ctx, OutboxName)
	if err != nil {
		return "", err
	}
	ids, err := ix.FindByMessageID(ctx, c.email, mid)
	if err != nil {
		return "", err
	}
	var inSent string
	var inOutbox []string
	for _, id := range ids {
		_, boxes, err := ix.Lookup(ctx, c.email, id)
		if err != nil {
			continue
		}
		if slices.Contains(boxes, sent.ID) && inSent == "" {
			inSent = id
		}
		if hasOutbox && slices.Contains(boxes, outbox.ID) {
			inOutbox = append(inOutbox, id)
		}
	}

	if inSent == "" && len(inOutbox) > 0 {
		inSent, inOutbox = inOutbox[0], inOutbox[1:]
		if err := c.engine.MoveMessages(ctx, c.email, []string{inSent}, outbox.ID, sent.ID); err != nil {
			return "", err
		}
		c.announceMembership(ctx, inSent, false)
		log.Printf("outbox: %s %s moved to %s", c.email, mid, sentName)
	}
	for _, id := range inOutbox {
		if id == inSent {
			continue
		}
		if err := c.removeCopy(ctx, id, outbox.ID); err != nil {
			log.Printf("outbox: could not remove %s from %s for %s: %v", id, OutboxName, c.email, err)
		} else {
			log.Printf("outbox: %s %s is already in %s, removed the %s copy", c.email, mid, sentName, OutboxName)
		}
	}
	if inSent != "" {
		return inSent, nil
	}
	log.Printf("outbox: %s %s had no %s copy, stored in %s", c.email, mid, OutboxName, sentName)
	return c.Deliver(ctx, sentName, literal, []string{imap.FlagSeen}, time.Now())
}
