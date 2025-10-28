package connector

import (
	"context"
	"database/sql"
	"sync"
	"time"

	"github.com/ProtonMail/gluon/imap"
)

// Implements a sample IMAP connector using a SQL database as the backend.
// For Reference See DummyConnector in dummy.go
type MyDBConnector struct {
	db      *sql.DB
	email   string
	updates chan imap.Update

	user struct {
		id    imap.UserID
		email string
	}

	allowUnknownMailbox        bool
	folderPrefix, labelsPrefix string
	updatesAllowedToFail       int32
	queueLock                  sync.Mutex
	queue                      []imap.Update
	mailboxVisibilities        map[imap.MailboxID]imap.MailboxVisibility
}

func NewConnector(db *sql.DB, email string) *MyDBConnector {
	return &MyDBConnector{
		db:                  db,
		email:               email,
		updates:             make(chan imap.Update, 500),
		user:                nil,
		allowUnknownMailbox: true,
		folderPrefix:        "",
		labelsPrefix:        "",
		mailboxVisibilities: make(map[imap.MailboxID]imap.MailboxVisibility),
	}
}

// Init the connector. The cache pointer provide here should not be used with any of the other methods.
func (c *MyDBConnector) Init(ctx context.Context, cache imap.IMAPState) error {
	return nil
}

// Authorize returns whether the given username/password combination are valid for this connector.
func (c *MyDBConnector) Authorize(ctx context.Context, username string, password []byte) bool {
	return nil
}

// CreateMailbox creates a mailbox with the given name.
func (c *MyDBConnector) CreateMailbox(ctx context.Context, cache imap.IMAPStateWrite, name []string) (imap.Mailbox, error) {
	return nil
}

// GetMessageLiteral is intended to be used by Gluon when, for some reason, the local cached data no longer exists.
// Note: this can get called from different go routines.
func (c *MyDBConnector) GetMessageLiteral(ctx context.Context, id imap.MessageID) ([]byte, error) {
	return nil
}

// GetMailboxVisibility can be used to retrieve the visibility of mailboxes for connected clients.
func (c *MyDBConnector) GetMailboxVisibility(ctx context.Context, mboxID imap.MailboxID) imap.MailboxVisibility {
	return nil
}

// UpdateMailboxName sets the name of the mailbox with the given ID.
func (c *MyDBConnector) UpdateMailboxName(ctx context.Context, cache imap.IMAPStateWrite, mboxID imap.MailboxID, newName []string) error {
	return nil
}

// DeleteMailbox deletes the mailbox with the given ID.
func (c *MyDBConnector) DeleteMailbox(ctx context.Context, cache imap.IMAPStateWrite, mboxID imap.MailboxID) error {
	return nil
}

// CreateMessage creates a new message on the remote.
func (c *MyDBConnector) CreateMessage(ctx context.Context, cache imap.IMAPStateWrite, mboxID imap.MailboxID, literal []byte, flags imap.FlagSet, date time.Time) (imap.Message, []byte, error) {
	return nil
}

// AddMessagesToMailbox adds the given messages to the given mailbox.
func (c *MyDBConnector) AddMessagesToMailbox(ctx context.Context, cache imap.IMAPStateWrite, messageIDs []imap.MessageID, mboxID imap.MailboxID) error {
	return nil
}

// RemoveMessagesFromMailbox removes the given messages from the given mailbox.
func (c *MyDBConnector) RemoveMessagesFromMailbox(ctx context.Context, cache imap.IMAPStateWrite, messageIDs []imap.MessageID, mboxID imap.MailboxID) error {
	return nil
}

// MoveMessages removes the given messages from one mailbox and adds them to the another mailbox.
// Returns true if the original messages should be removed from mboxFromID (e.g: Distinguishing between labels and folders).
func (c *MyDBConnector) MoveMessages(ctx context.Context, cache imap.IMAPStateWrite, messageIDs []imap.MessageID, mboxFromID, mboxToID imap.MailboxID) (bool, error) {
	return nil
}

// MarkMessagesSeen sets the seen value of the given messages.
func (c *MyDBConnector) MarkMessagesSeen(ctx context.Context, cache imap.IMAPStateWrite, messageIDs []imap.MessageID, seen bool) error {
	return nil
}

// MarkMessagesFlagged sets the flagged value of the given messages.
func (c *MyDBConnector) MarkMessagesFlagged(ctx context.Context, cache imap.IMAPStateWrite, messageIDs []imap.MessageID, flagged bool) error {
	return nil
}

// MarkMessagesForwarded sets the forwarded value of the give messages.
func (c *MyDBConnector) MarkMessagesForwarded(ctx context.Context, cache imap.IMAPStateWrite, messageIDs []imap.MessageID, forwarded bool) error {
	return nil
}

// GetUpdates returns a stream of updates that the gluon server should apply.
func (c *MyDBConnector) GetUpdates() <-chan imap.Update {
	return nil
}

// Close the connector will no longer be used and all resources should be closed/released.
func (c *MyDBConnector) Close(ctx context.Context) error {
	return nil
}
