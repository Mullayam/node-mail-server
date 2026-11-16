package connector

import (
	"context"

	"github.com/ProtonMail/gluon/connector"
	"github.com/ProtonMail/gluon/imap"
)

// SetMailboxSubscribed sets whether the mailbox with the given ID is subscribed.
// The storage engine has no place for subscriptions, so Gluon keeps them.
func (c *MyDBConnector) SetMailboxSubscribed(ctx context.Context, cache connector.IMAPStateWrite, mboxID imap.MailboxID, subscribed bool) error {
	return nil
}
