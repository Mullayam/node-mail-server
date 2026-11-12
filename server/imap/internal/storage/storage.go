// Package storage is the upper layer for where mail is kept.
//
// The Gluon connector (core/connector) calls an Engine for every mailbox and
// message operation. Engines are pluggable: imap.xml picks one with
// <storage engine="...">, and any extra attributes are passed as options.
// Built in:
//
//	pebble    the KV engine on Pebble, on disk (path="..."). Fully implemented.
//	memory    the KV engine in memory, for tests. Lost on restart.
//	dir       placeholder: one folder per account on disk (path="...")
//	postgres  placeholder: a Postgres database (dsn="...")
//
// The placeholders return ErrNotImplemented from every method. To add your
// own engine, either give the KV engine a new kv.Store driver, or embed
// Unimplemented, override the methods you support and call Register from an
// init function.
package storage

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"imap/internal/quota"
)

var (
	// ErrNotImplemented is returned by Unimplemented and the placeholder engines.
	ErrNotImplemented  = errors.New("not implemented by this storage engine")
	ErrMailboxNotFound = errors.New("mailbox not found")
	ErrMessageNotFound = errors.New("message not found")
)

// Mailbox is one folder of an account.
type Mailbox struct {
	ID   string   `json:"id"`
	Name []string `json:"name"` // path parts, for example ["Archive", "2026"]
}

// Message is a message's metadata. The body is read with GetMessage.
type Message struct {
	ID    string    `json:"id"`
	Size  int64     `json:"size"`
	Flags []string  `json:"flags"`
	Date  time.Time `json:"date"`
}

// Engine stores mailboxes and messages for every account. IDs are opaque
// strings chosen by the engine.
type Engine interface {
	ListMailboxes(ctx context.Context, account string) ([]Mailbox, error)
	ListMessages(ctx context.Context, account, mailboxID string) ([]Message, error)

	CreateMailbox(ctx context.Context, account string, name []string) (mailboxID string, err error)
	RenameMailbox(ctx context.Context, account, mailboxID string, newName []string) error
	DeleteMailbox(ctx context.Context, account, mailboxID string) error

	CreateMessage(ctx context.Context, account, mailboxID string, literal []byte, flags []string, date time.Time) (messageID string, err error)
	GetMessage(ctx context.Context, account, messageID string) ([]byte, error)
	AddToMailbox(ctx context.Context, account string, messageIDs []string, mailboxID string) error
	RemoveFromMailbox(ctx context.Context, account string, messageIDs []string, mailboxID string) error
	MoveMessages(ctx context.Context, account string, messageIDs []string, fromID, toID string) error
	SetFlag(ctx context.Context, account string, messageIDs []string, flag string, on bool) error

	// Usage feeds the quota check.
	Usage(ctx context.Context, account string) (quota.Usage, error)
	Close() error
}

// Factory builds an Engine from the options in imap.xml.
type Factory func(options map[string]string) (Engine, error)

var (
	mu      sync.RWMutex
	engines = map[string]Factory{}
)

// Register makes an engine available to imap.xml. Call it from an init function.
func Register(name string, f Factory) {
	mu.Lock()
	defer mu.Unlock()
	engines[name] = f
}

// Open builds the named engine.
func Open(name string, options map[string]string) (Engine, error) {
	mu.RLock()
	f, ok := engines[name]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown storage engine %q (registered: %s)", name, strings.Join(Engines(), ", "))
	}
	return f(options)
}

// Engines lists the registered engines.
func Engines() []string {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]string, 0, len(engines))
	for k := range engines {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Unimplemented returns ErrNotImplemented from every method. Embed it in your
// engine and override the methods you support.
type Unimplemented struct{ Engine string }

func (u Unimplemented) err(op string) error {
	return fmt.Errorf("%s: %s: %w", u.Engine, op, ErrNotImplemented)
}

func (u Unimplemented) ListMailboxes(context.Context, string) ([]Mailbox, error) {
	return nil, u.err("list mailboxes")
}
func (u Unimplemented) ListMessages(context.Context, string, string) ([]Message, error) {
	return nil, u.err("list messages")
}
func (u Unimplemented) CreateMailbox(context.Context, string, []string) (string, error) {
	return "", u.err("create mailbox")
}
func (u Unimplemented) RenameMailbox(context.Context, string, string, []string) error {
	return u.err("rename mailbox")
}
func (u Unimplemented) DeleteMailbox(context.Context, string, string) error {
	return u.err("delete mailbox")
}
func (u Unimplemented) CreateMessage(context.Context, string, string, []byte, []string, time.Time) (string, error) {
	return "", u.err("create message")
}
func (u Unimplemented) GetMessage(context.Context, string, string) ([]byte, error) {
	return nil, u.err("get message")
}
func (u Unimplemented) AddToMailbox(context.Context, string, []string, string) error {
	return u.err("add to mailbox")
}
func (u Unimplemented) RemoveFromMailbox(context.Context, string, []string, string) error {
	return u.err("remove from mailbox")
}
func (u Unimplemented) MoveMessages(context.Context, string, []string, string, string) error {
	return u.err("move messages")
}
func (u Unimplemented) SetFlag(context.Context, string, []string, string, bool) error {
	return u.err("set flag")
}
func (u Unimplemented) Usage(context.Context, string) (quota.Usage, error) {
	return quota.Usage{}, u.err("usage")
}
func (u Unimplemented) Close() error { return nil }
