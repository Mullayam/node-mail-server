package connector

import (
	"context"

	"github.com/ProtonMail/gluon/imap"
	"github.com/ProtonMail/gluon/imap/command"
)

// SearchMessages lets the connector answer a search from its own index.
// This server has no search index yet, so it leaves every search to Gluon.
func (c *MyDBConnector) SearchMessages(ctx context.Context, mboxID imap.MailboxID, keys []command.SearchKey) ([]imap.MessageID, bool, error) {
	return nil, false, nil
}
