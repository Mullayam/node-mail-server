// Package quota holds mailbox limits and the check that enforces them.
//
// Limits come from two places: the defaults in imap.xml (<quota>) and an
// optional per-user override kept by the directory. Usage comes from the
// storage engine, which is where the messages live.
package quota

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
)

// ErrExceeded is returned by Check when a new message would go over the limit.
var ErrExceeded = errors.New("quota exceeded")

// Limit is a mailbox limit. Zero means unlimited.
type Limit struct {
	StorageBytes int64 `json:"storage_bytes"`
	Messages     int64 `json:"messages"`
}

// Usage is what an account currently uses.
type Usage struct {
	StorageBytes int64 `json:"storage_bytes"`
	Messages     int64 `json:"messages"`
}

// UsageSource reports usage. The storage engine implements it.
type UsageSource interface {
	Usage(ctx context.Context, account string) (Usage, error)
}

// Manager resolves limits and checks them.
type Manager struct {
	defaults atomic.Pointer[Limit]
	usage    UsageSource
}

// NewManager returns a Manager with the given defaults.
func NewManager(defaults Limit, usage UsageSource) *Manager {
	m := &Manager{usage: usage}
	m.SetDefaults(defaults)
	return m
}

// SetDefaults replaces the defaults. Reload calls it.
func (m *Manager) SetDefaults(l Limit) { m.defaults.Store(&l) }

// Defaults returns the current defaults.
func (m *Manager) Defaults() Limit { return *m.defaults.Load() }

// Effective returns the user's override, or the defaults when there is none.
func (m *Manager) Effective(override *Limit) Limit {
	if override != nil {
		return *override
	}
	return m.Defaults()
}

// Usage asks the storage engine. It returns the engine's error as is, which
// is ErrNotImplemented for the built-in placeholder engines.
func (m *Manager) Usage(ctx context.Context, account string) (Usage, error) {
	return m.usage.Usage(ctx, account)
}

// Check reports ErrExceeded if adding one message of addBytes would go over
// the limit. When usage is unknown (the engine cannot report it), the message
// is allowed: a placeholder engine must not block all mail.
func (m *Manager) Check(ctx context.Context, account string, limit Limit, addBytes int64) error {
	if limit.StorageBytes == 0 && limit.Messages == 0 {
		return nil
	}
	u, err := m.usage.Usage(ctx, account)
	if err != nil {
		return nil
	}
	if limit.StorageBytes > 0 && u.StorageBytes+addBytes > limit.StorageBytes {
		return fmt.Errorf("%w: storage %s of %s", ErrExceeded, FormatSize(u.StorageBytes+addBytes), FormatSize(limit.StorageBytes))
	}
	if limit.Messages > 0 && u.Messages+1 > limit.Messages {
		return fmt.Errorf("%w: %d of %d messages", ErrExceeded, u.Messages+1, limit.Messages)
	}
	return nil
}

var units = []struct {
	suffix string
	size   int64
}{{"TB", 1 << 40}, {"GB", 1 << 30}, {"MB", 1 << 20}, {"KB", 1 << 10}, {"B", 1}}

// ParseSize reads sizes like "500MB", "1GB" or "1024". Empty and "0" mean unlimited.
func ParseSize(s string) (int64, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if s == "" || s == "0" || s == "UNLIMITED" {
		return 0, nil
	}
	for _, u := range units {
		if num, ok := strings.CutSuffix(s, u.suffix); ok {
			n, err := strconv.ParseFloat(strings.TrimSpace(num), 64)
			if err != nil || n < 0 {
				return 0, fmt.Errorf("invalid size %q", s)
			}
			return int64(n * float64(u.size)), nil
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid size %q (use B, KB, MB, GB or TB)", s)
	}
	return n, nil
}

// ParseCount reads a message count. Empty and "0" mean unlimited.
func ParseCount(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid message count %q", s)
	}
	return n, nil
}

// FormatSize prints bytes with the largest whole unit, for example "1GB".
func FormatSize(n int64) string {
	if n == 0 {
		return "unlimited"
	}
	for _, u := range units {
		if n >= u.size && n%u.size == 0 {
			return strconv.FormatInt(n/u.size, 10) + u.suffix
		}
	}
	return strconv.FormatInt(n, 10) + "B"
}
