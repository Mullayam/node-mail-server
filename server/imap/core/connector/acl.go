package connector

import (
	"context"

	"github.com/ProtonMail/gluon/connector"
	"github.com/ProtonMail/gluon/imap"
)

func (c *MyDBConnector) GetMailboxACL(ctx context.Context, mboxID imap.MailboxID) ([]imap.ACLEntry, error) {
	return []imap.ACLEntry{{Identifier: c.email, Rights: imap.ACLRights}}, nil
}

func (c *MyDBConnector) SetMailboxACL(ctx context.Context, mboxID imap.MailboxID, identifier string, rights string) error {
	return connector.ErrOperationNotAllowed
}

func (c *MyDBConnector) ListMailboxRights(ctx context.Context, mboxID imap.MailboxID, identifier string) (string, []string, error) {
	if identifier == c.email {
		return imap.ACLRights, nil, nil
	}
	return "", nil, nil
}

func (c *MyDBConnector) GetMyMailboxRights(ctx context.Context, mboxID imap.MailboxID) (string, error) {
	return imap.ACLRights, nil
}
