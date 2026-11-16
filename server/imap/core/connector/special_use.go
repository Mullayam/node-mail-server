package connector

import (
	"context"

	"github.com/ProtonMail/gluon/connector"
	"github.com/ProtonMail/gluon/imap"
)

// CreateSpecialUseMailbox creates a mailbox for CREATE ... (USE (...)).
// This server gives a folder its special use by its name, such as "Sent" or "Junk", so a client can only ask for
// the use the name already has.
func (c *MyDBConnector) CreateSpecialUseMailbox(ctx context.Context, cache connector.IMAPStateWrite, name []string, attributes imap.FlagSet) (imap.Mailbox, error) {
	role := roleOf(name)
	if role == "" || attributes.Len() != 1 || !attributes.Contains(role) {
		return imap.Mailbox{}, connector.ErrSpecialUseNotSupported
	}
	return c.CreateMailbox(ctx, cache, name)
}
