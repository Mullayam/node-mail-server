package connector

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/ProtonMail/gluon/connector"
	"github.com/ProtonMail/gluon/imap"

	"imap/internal/directorykind"
	"imap/internal/quota"
	"imap/internal/storage"
)

// Implements a sample IMAP connector using a SQL database as the backend.
// For Reference See DummyConnector in dummy.go
type MyDBConnector struct {
	email   string
	dir     directorykind.Directory
	engine  storage.Engine
	quota   *quota.Manager
	updates chan imap.Update

	mu       sync.RWMutex
	isClosed bool

	user struct {
		id    string
		email string
	}

	allowUnknownMailbox        bool
	folderPrefix, labelsPrefix string
	mailboxVisibilities        map[imap.MailboxID]imap.MailboxVisibility

	onDeleted func(ctx context.Context, account string, messageIDs []string)
}

var _ connector.Connector = (*MyDBConnector)(nil)

var (
	defaultFlags     = imap.NewFlagSet(imap.FlagSeen, imap.FlagFlagged, imap.FlagDeleted)
	defaultPermFlags = imap.NewFlagSet(imap.FlagSeen, imap.FlagFlagged, imap.FlagDeleted)
	defaultAttrs     = imap.NewFlagSet()
)

func NewConnector(email string, dir directorykind.Directory, engine storage.Engine, q *quota.Manager) *MyDBConnector {
	c := &MyDBConnector{
		email:               directorykind.Normalize(email),
		dir:                 dir,
		engine:              engine,
		quota:               q,
		updates:             make(chan imap.Update, 500),
		allowUnknownMailbox: true,
		folderPrefix:        "",
		labelsPrefix:        "",
		mailboxVisibilities: make(map[imap.MailboxID]imap.MailboxVisibility),
	}
	c.user.email = c.email
	return c
}

func (c *MyDBConnector) Sync(ctx context.Context, fresh bool) error {
	mboxes, err := c.engine.ListMailboxes(ctx, c.email)
	if errors.Is(err, storage.ErrNotImplemented) {
		return nil
	}
	if err != nil {
		return err
	}

	var created []storage.Mailbox
	if !slices.ContainsFunc(mboxes, isInbox) {
		id, err := c.engine.CreateMailbox(ctx, c.email, []string{imap.Inbox})
		if err != nil {
			return fmt.Errorf("create INBOX: %w", err)
		}
		inbox := storage.Mailbox{ID: id, Name: []string{imap.Inbox}}
		mboxes = append(mboxes, inbox)
		created = append(created, inbox)
	}

	announce := created
	if fresh {
		announce = mboxes
	}
	for _, m := range announce {
		if err := c.push(ctx, imap.NewMailboxCreated(gluonMailbox(m))); err != nil {
			return fmt.Errorf("announce mailbox %v: %w", m.Name, err)
		}
	}
	if !fresh {
		return nil
	}

	type entry struct {
		msg   storage.Message
		boxes []imap.MailboxID
	}
	byID := map[string]*entry{}
	var order []string
	for _, m := range mboxes {
		msgs, err := c.engine.ListMessages(ctx, c.email, m.ID)
		if err != nil {
			return err
		}
		for _, msg := range msgs {
			e, seen := byID[msg.ID]
			if !seen {
				e = &entry{msg: msg}
				byID[msg.ID] = e
				order = append(order, msg.ID)
			}
			e.boxes = append(e.boxes, imap.MailboxID(m.ID))
		}
	}

	const chunk = 25
	var batch []*imap.MessageCreated
	for i, id := range order {
		literal, err := c.engine.GetMessage(ctx, c.email, id)
		if err != nil {
			return err
		}
		parsed, err := imap.NewParsedMessage(literal)
		if err != nil {
			return fmt.Errorf("parse message %s: %w", id, err)
		}
		e := byID[id]
		batch = append(batch, &imap.MessageCreated{
			Message:       imap.Message{ID: imap.MessageID(id), Flags: imap.NewFlagSetFromSlice(e.msg.Flags), Date: e.msg.Date},
			Literal:       literal,
			MailboxIDs:    e.boxes,
			ParsedMessage: parsed,
		})
		if len(batch) == chunk || i == len(order)-1 {
			if err := c.push(ctx, imap.NewMessagesCreated(true, batch...)); err != nil {
				return fmt.Errorf("announce messages: %w", err)
			}
			batch = nil
		}
	}
	return nil
}

func isInbox(m storage.Mailbox) bool {
	return len(m.Name) == 1 && strings.EqualFold(m.Name[0], imap.Inbox)
}

func gluonMailbox(m storage.Mailbox) imap.Mailbox {
	return imap.Mailbox{
		ID:             imap.MailboxID(m.ID),
		Name:           m.Name,
		Flags:          defaultFlags,
		PermanentFlags: defaultPermFlags,
		Attributes:     specialUse(m.Name),
	}
}

func specialUse(name []string) imap.FlagSet {
	if len(name) != 1 {
		return defaultAttrs
	}
	switch strings.ToLower(name[0]) {
	case "junk", "spam":
		return imap.NewFlagSet(imap.AttrJunk)
	case "sent", "sent items", "sent mail":
		return imap.NewFlagSet(imap.AttrSent)
	case "drafts":
		return imap.NewFlagSet(imap.AttrDrafts)
	case "trash", "deleted items":
		return imap.NewFlagSet(imap.AttrTrash)
	case "archive":
		return imap.NewFlagSet(imap.AttrArchive)
	}
	return defaultAttrs
}

func (c *MyDBConnector) EnsureMailbox(ctx context.Context, name string) (storage.Mailbox, error) {
	mboxes, err := c.engine.ListMailboxes(ctx, c.email)
	if err != nil {
		return storage.Mailbox{}, err
	}
	for _, m := range mboxes {
		if len(m.Name) == 1 && strings.EqualFold(m.Name[0], name) {
			return m, nil
		}
	}
	id, err := c.engine.CreateMailbox(ctx, c.email, []string{name})
	if err != nil {
		return storage.Mailbox{}, err
	}
	m := storage.Mailbox{ID: id, Name: []string{name}}
	if err := c.push(ctx, imap.NewMailboxCreated(gluonMailbox(m))); err != nil {
		return storage.Mailbox{}, fmt.Errorf("announce mailbox %s: %w", name, err)
	}
	return m, nil
}

// Init the connector. The cache pointer provide here should not be used with any of the other methods.
func (c *MyDBConnector) Init(ctx context.Context, cache connector.IMAPState) error {
	return nil
}

// Authorize returns whether the given username/password combination are valid for this connector.

func (c *MyDBConnector) Authorize(ctx context.Context, username string, password []byte) bool {
	if directorykind.Normalize(username) != c.email {
		return false
	}
	u, err := c.dir.Authenticate(ctx, username, string(password))
	return err == nil && directorykind.IMAPAllowed(u)
}

// CreateMailbox creates a mailbox with the given name.
func (c *MyDBConnector) CreateMailbox(ctx context.Context, cache connector.IMAPStateWrite, name []string) (imap.Mailbox, error) {
	id, err := c.engine.CreateMailbox(ctx, c.email, name)
	if err != nil {
		return imap.Mailbox{}, err
	}
	return imap.Mailbox{
		ID:             imap.MailboxID(id),
		Name:           name,
		Flags:          defaultFlags,
		PermanentFlags: defaultPermFlags,
		Attributes:     defaultAttrs,
	}, nil
}

// GetMessageLiteral is intended to be used by Gluon when, for some reason, the local cached data no longer exists.
// Note: this can get called from different go routines.
func (c *MyDBConnector) GetMessageLiteral(ctx context.Context, id imap.MessageID) ([]byte, error) {
	return c.engine.GetMessage(ctx, c.email, string(id))
}

// GetMailboxVisibility can be used to retrieve the visibility of mailboxes for connected clients.
func (c *MyDBConnector) GetMailboxVisibility(ctx context.Context, mboxID imap.MailboxID) imap.MailboxVisibility {
	if v, ok := c.mailboxVisibilities[mboxID]; ok {
		return v
	}
	return imap.Visible
}

// UpdateMailboxName sets the name of the mailbox with the given ID.
func (c *MyDBConnector) UpdateMailboxName(ctx context.Context, cache connector.IMAPStateWrite, mboxID imap.MailboxID, newName []string) error {
	return c.engine.RenameMailbox(ctx, c.email, string(mboxID), newName)
}

// DeleteMailbox deletes the mailbox with the given ID.
func (c *MyDBConnector) DeleteMailbox(ctx context.Context, cache connector.IMAPStateWrite, mboxID imap.MailboxID) error {
	var inside []string
	if msgs, err := c.engine.ListMessages(ctx, c.email, string(mboxID)); err == nil {
		for _, m := range msgs {
			inside = append(inside, m.ID)
		}
	}
	if err := c.engine.DeleteMailbox(ctx, c.email, string(mboxID)); err != nil {
		return err
	}
	c.deleted(ctx, inside)
	return nil
}

// CreateMessage creates a new message on the remote.
func (c *MyDBConnector) CreateMessage(ctx context.Context, cache connector.IMAPStateWrite, mboxID imap.MailboxID, literal []byte, flags imap.FlagSet, date time.Time) (imap.Message, []byte, error) {
	var override *quota.Limit
	if u, err := c.dir.Get(ctx, c.email); err == nil {
		override = u.Quota
	}
	if err := c.quota.Check(ctx, c.email, c.quota.Effective(override), int64(len(literal))); err != nil {
		return imap.Message{}, nil, err
	}
	id, err := c.engine.CreateMessage(ctx, c.email, string(mboxID), literal, flags.ToSlice(), date)
	if err != nil {
		return imap.Message{}, nil, err
	}
	return imap.Message{ID: imap.MessageID(id), Flags: flags, Date: date}, literal, nil
}

// AddMessagesToMailbox adds the given messages to the given mailbox.
func (c *MyDBConnector) AddMessagesToMailbox(ctx context.Context, cache connector.IMAPStateWrite, messageIDs []imap.MessageID, mboxID imap.MailboxID) error {
	return c.engine.AddToMailbox(ctx, c.email, ids(messageIDs), string(mboxID))
}

// RemoveMessagesFromMailbox removes the given messages from the given mailbox.
func (c *MyDBConnector) RemoveMessagesFromMailbox(ctx context.Context, cache connector.IMAPStateWrite, messageIDs []imap.MessageID, mboxID imap.MailboxID) error {
	if err := c.engine.RemoveFromMailbox(ctx, c.email, ids(messageIDs), string(mboxID)); err != nil {
		return err
	}
	c.deleted(ctx, ids(messageIDs))
	return nil
}

// MoveMessages removes the given messages from one mailbox and adds them to the another mailbox.
// Returns true if the original messages should be removed from mboxFromID (e.g: Distinguishing between labels and folders).
func (c *MyDBConnector) MoveMessages(ctx context.Context, cache connector.IMAPStateWrite, messageIDs []imap.MessageID, mboxFromID, mboxToID imap.MailboxID) (bool, error) {
	if err := c.engine.MoveMessages(ctx, c.email, ids(messageIDs), string(mboxFromID), string(mboxToID)); err != nil {
		return false, err
	}
	return true, nil
}

// MarkMessagesSeen sets the seen value of the given messages.
func (c *MyDBConnector) MarkMessagesSeen(ctx context.Context, cache connector.IMAPStateWrite, messageIDs []imap.MessageID, seen bool) error {
	return c.engine.SetFlag(ctx, c.email, ids(messageIDs), imap.FlagSeen, seen)
}

// MarkMessagesFlagged sets the flagged value of the given messages.
func (c *MyDBConnector) MarkMessagesFlagged(ctx context.Context, cache connector.IMAPStateWrite, messageIDs []imap.MessageID, flagged bool) error {
	return c.engine.SetFlag(ctx, c.email, ids(messageIDs), imap.FlagFlagged, flagged)
}

// MarkMessagesForwarded sets the forwarded value of the give messages.
func (c *MyDBConnector) MarkMessagesForwarded(ctx context.Context, cache connector.IMAPStateWrite, messageIDs []imap.MessageID, forwarded bool) error {
	return c.engine.SetFlag(ctx, c.email, ids(messageIDs), imap.XFlagDollarForwarded, forwarded)
}

// GetUpdates returns a stream of updates that the gluon server should apply.
func (c *MyDBConnector) GetUpdates() <-chan imap.Update {
	return c.updates
}

// Close the connector will no longer be used and all resources should be closed/released.
func (c *MyDBConnector) Close(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.isClosed {
		c.isClosed = true
		close(c.updates)
	}
	return nil
}

var (
	ErrClosed = errors.New("connector closed: the user is no longer loaded in Gluon")

	ErrInvalidMessage = errors.New("invalid message")
)

func (c *MyDBConnector) push(ctx context.Context, u imap.Update) error {
	c.mu.RLock()
	if c.isClosed {
		c.mu.RUnlock()
		return ErrClosed
	}
	select {
	case c.updates <- u:
		c.mu.RUnlock()
	case <-ctx.Done():
		c.mu.RUnlock()
		return ctx.Err()
	}

	if err, _ := u.WaitContext(ctx); err != nil {
		return err
	}
	return ctx.Err()
}

func (c *MyDBConnector) SetDeleted(fn func(ctx context.Context, account string, messageIDs []string)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onDeleted = fn
}

func (c *MyDBConnector) deleted(ctx context.Context, candidates []string) {
	c.mu.RLock()
	fn := c.onDeleted
	c.mu.RUnlock()
	if fn == nil || len(candidates) == 0 {
		return
	}
	var gone []string
	for _, id := range candidates {
		if _, err := c.engine.GetMessage(ctx, c.email, id); errors.Is(err, storage.ErrMessageNotFound) {
			gone = append(gone, id)
		}
	}
	if len(gone) > 0 {
		fn(context.WithoutCancel(ctx), c.email, gone)
	}
}

func (c *MyDBConnector) Deliver(ctx context.Context, mailbox string, literal []byte, flags []string, date time.Time) (string, error) {
	mboxes, err := c.engine.ListMailboxes(ctx, c.email)
	if err != nil {
		return "", err
	}
	idx := slices.IndexFunc(mboxes, func(m storage.Mailbox) bool {
		name := strings.Join(m.Name, "/")
		return name == mailbox || (isInbox(m) && strings.EqualFold(mailbox, imap.Inbox))
	})
	if idx < 0 {
		return "", fmt.Errorf("%w: %s", storage.ErrMailboxNotFound, mailbox)
	}
	mboxID := mboxes[idx].ID

	parsed, err := imap.NewParsedMessage(literal)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidMessage, err)
	}

	var override *quota.Limit
	if u, err := c.dir.Get(ctx, c.email); err == nil {
		override = u.Quota
	}
	if err := c.quota.Check(ctx, c.email, c.quota.Effective(override), int64(len(literal))); err != nil {
		return "", err
	}

	id, err := c.engine.CreateMessage(ctx, c.email, mboxID, literal, flags, date)
	if err != nil {
		return "", err
	}
	update := imap.NewMessagesCreated(false, &imap.MessageCreated{
		Message:       imap.Message{ID: imap.MessageID(id), Flags: imap.NewFlagSetFromSlice(flags), Date: date},
		Literal:       literal,
		MailboxIDs:    []imap.MailboxID{imap.MailboxID(mboxID)},
		ParsedMessage: parsed,
	})
	if err := c.push(ctx, update); err != nil {

		c.engine.RemoveFromMailbox(context.WithoutCancel(ctx), c.email, []string{id}, mboxID)
		return "", fmt.Errorf("gluon did not accept the message: %w", err)
	}
	return id, nil
}

func ids(in []imap.MessageID) []string {
	out := make([]string, len(in))
	for i, id := range in {
		out[i] = string(id)
	}
	return out
}
