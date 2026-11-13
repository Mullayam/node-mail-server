package quota

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
)

var ErrExceeded = errors.New("quota exceeded")

type Limit struct {
	StorageBytes int64 `json:"storage_bytes"`
	Messages     int64 `json:"messages"`
}

type Usage struct {
	StorageBytes int64 `json:"storage_bytes"`
	Messages     int64 `json:"messages"`
}

type UsageSource interface {
	Usage(ctx context.Context, account string) (Usage, error)
}

type Manager struct {
	defaults atomic.Pointer[Limit]
	usage    UsageSource
}

func NewManager(defaults Limit, usage UsageSource) *Manager {
	m := &Manager{usage: usage}
	m.SetDefaults(defaults)
	return m
}

func (m *Manager) SetDefaults(l Limit) { m.defaults.Store(&l) }

func (m *Manager) Defaults() Limit { return *m.defaults.Load() }

func (m *Manager) Effective(override *Limit) Limit {
	if override != nil {
		return *override
	}
	return m.Defaults()
}

func (m *Manager) Usage(ctx context.Context, account string) (Usage, error) {
	return m.usage.Usage(ctx, account)
}

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
