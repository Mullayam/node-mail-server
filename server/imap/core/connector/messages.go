package connector

import (
	"context"

	"github.com/ProtonMail/gluon/connector"
	"github.com/ProtonMail/gluon/imap"
)

// CreateMessages creates the messages of an APPEND command that carries more than one message.
// Either all of them are stored or none: when one cannot be stored, the ones before it are taken back.
func (c *MyDBConnector) CreateMessages(ctx context.Context, cache connector.IMAPStateWrite, mboxID imap.MailboxID, messages []connector.MessageToCreate) ([]imap.Message, [][]byte, error) {
	size := 0
	for _, m := range messages {
		size += len(m.Literal)
	}
	if err := c.checkQuota(ctx, size); err != nil {
		return nil, nil, err
	}

	starred := c.isStarred(string(mboxID))
	created := make([]imap.Message, 0, len(messages))
	literals := make([][]byte, 0, len(messages))

	for _, m := range messages {
		flags := m.Flags
		if starred {
			flags = flags.Add(imap.FlagFlagged)
		}
		id, err := c.engine.CreateMessage(ctx, c.email, string(mboxID), m.Literal, flags.ToSlice(), m.Date)
		if err != nil {
			stored := make([]imap.MessageID, 0, len(created))
			for _, msg := range created {
				stored = append(stored, msg.ID)
			}
			if len(stored) > 0 {
				_ = c.RemoveMessagesFromMailbox(ctx, cache, stored, mboxID)
			}
			return nil, nil, err
		}
		created = append(created, imap.Message{ID: imap.MessageID(id), Flags: flags, Date: m.Date})
		literals = append(literals, m.Literal)
	}
	return created, literals, nil
}
