package connector

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"

	"github.com/ProtonMail/gluon/connector"
	"github.com/ProtonMail/gluon/imap"

	"imap/internal/quota"
)

const QuotaRoot = ""

func (c *MyDBConnector) GetQuota(ctx context.Context, rootName string) (*imap.QuotaRoot, error) {
	if rootName != QuotaRoot {
		return nil, fmt.Errorf("no such quota root %q", rootName)
	}
	return c.quotaRoot(ctx)
}

func (c *MyDBConnector) GetQuotaRoot(ctx context.Context, mailboxName string) ([]string, []*imap.QuotaRoot, error) {
	if !strings.EqualFold(mailboxName, imap.Inbox) {
		if _, found, err := c.findMailbox(ctx, mailboxName); err != nil {
			return nil, nil, err
		} else if !found {
			return nil, nil, fmt.Errorf("no such mailbox %q", mailboxName)
		}
	}
	root, err := c.quotaRoot(ctx)
	if err != nil {
		return nil, nil, err
	}
	return []string{QuotaRoot}, []*imap.QuotaRoot{root}, nil
}

func (c *MyDBConnector) limit(ctx context.Context) quota.Limit {
	var override *quota.Limit
	if u, err := c.dir.Get(ctx, c.email); err == nil {
		override = u.Quota
	}
	return c.quota.Effective(override)
}

func (c *MyDBConnector) checkQuota(ctx context.Context, size int) error {
	err := c.quota.Check(ctx, c.email, c.limit(ctx), int64(size))
	if errors.Is(err, quota.ErrExceeded) {
		return fmt.Errorf("%w: %w", connector.ErrOverQuota, err)
	}
	return err
}

func (c *MyDBConnector) quotaRoot(ctx context.Context) (*imap.QuotaRoot, error) {
	limit := c.limit(ctx)
	usage, err := c.quota.Usage(ctx, c.email)
	if err != nil {
		return nil, err
	}
	root := &imap.QuotaRoot{RootName: QuotaRoot}
	if limit.StorageBytes > 0 {
		root.Resources = append(root.Resources, imap.QuotaResource{
			ResourceName: "STORAGE",
			Usage:        kib(usage.StorageBytes),
			Limit:        kib(limit.StorageBytes),
		})
	}
	if limit.Messages > 0 {
		root.Resources = append(root.Resources, imap.QuotaResource{
			ResourceName: "MESSAGE",
			Usage:        clamp(usage.Messages),
			Limit:        clamp(limit.Messages),
		})
	}
	return root, nil
}

func kib(bytes int64) uint32 { return clamp((bytes + 1023) / 1024) }

func clamp(n int64) uint32 {
	switch {
	case n < 0:
		return 0
	case n > math.MaxUint32:
		return math.MaxUint32
	}
	return uint32(n)
}
