package connector

import (
	"context"

	"github.com/ProtonMail/gluon/connector"
	"github.com/ProtonMail/gluon/imap"
)

func (c *MyDBConnector) GetMetadata(ctx context.Context, mboxID imap.MailboxID) ([]imap.MetadataEntry, error) {
	return nil, nil
}

func (c *MyDBConnector) SetMetadata(ctx context.Context, mboxID imap.MailboxID, entries []imap.MetadataEntry) error {
	for _, e := range entries {
		if e.Value != nil {
			return connector.ErrMetadataTooMany
		}
	}
	return nil
}
