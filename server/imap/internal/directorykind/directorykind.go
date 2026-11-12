// Package directorykind is the user list: the SMTP users, and whether each one
// may use IMAP.
//
// The rule is simple: a user must be in the directory (an SMTP user) and have
// IMAP enabled. Only those users are loaded into Gluon, so only they can log in.
//
// Where the users are stored is pluggable. A "kind" is a backend registered
// with Register; imap.xml picks one with <directory kind="...">. Built in:
//
//	file      users.xml on disk (read and reload work; writes are stubs)
//	postgres  placeholder, every method returns ErrNotImplemented
//
// To add your own, embed Unimplemented, override what you support, and call
// Register from an init function.
package directorykind

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"imap/internal/quota"
)

var (
	ErrNotFound       = errors.New("user not found")
	ErrExists         = errors.New("user already exists")
	ErrBadCredentials = errors.New("invalid credentials")
	ErrNotImplemented = errors.New("not implemented by this directory kind")
)

// User is one mail account.
type User struct {
	Address  string       `json:"address"`         // login name, user@domain, lower case
	Password string       `json:"-"`               // never sent over the control socket
	IMAP     bool         `json:"imap"`            // IMAP enabled
	Quota    *quota.Limit `json:"quota,omitempty"` // nil means the default quota
}

// Directory stores users. Every kind implements it.
type Directory interface {
	// Load (re)reads the users from the source. It runs at start and on reload.
	Load(ctx context.Context) error
	List(ctx context.Context) ([]User, error)
	Get(ctx context.Context, address string) (User, error)
	// Authenticate checks a password and returns the user. Kinds that store
	// hashes compare hashes here.
	Authenticate(ctx context.Context, address, password string) (User, error)
	Add(ctx context.Context, u User) error
	Update(ctx context.Context, u User) error
	Delete(ctx context.Context, address string) error
	Close() error
}

// IMAPAllowed is the access rule: the user exists and has IMAP enabled.
func IMAPAllowed(u User) bool { return u.Address != "" && u.IMAP }

// Normalize lower-cases and trims an address.
func Normalize(address string) string { return strings.ToLower(strings.TrimSpace(address)) }

// Factory builds a Directory from the options in imap.xml.
type Factory func(options map[string]string) (Directory, error)

var (
	mu    sync.RWMutex
	kinds = map[string]Factory{}
)

// Register makes a kind available to imap.xml. Call it from an init function.
func Register(kind string, f Factory) {
	mu.Lock()
	defer mu.Unlock()
	kinds[kind] = f
}

// Open builds the directory named by kind.
func Open(kind string, options map[string]string) (Directory, error) {
	mu.RLock()
	f, ok := kinds[kind]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown directory kind %q (registered: %s)", kind, strings.Join(Kinds(), ", "))
	}
	return f(options)
}

// Kinds lists the registered kinds.
func Kinds() []string {
	mu.RLock()
	defer mu.RUnlock()
	out := make([]string, 0, len(kinds))
	for k := range kinds {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Unimplemented returns ErrNotImplemented from every method. Embed it in your
// own kind and override the methods you support.
type Unimplemented struct{ Kind string }

func (u Unimplemented) err(op string) error {
	return fmt.Errorf("%s: %s: %w", u.Kind, op, ErrNotImplemented)
}

func (u Unimplemented) Load(context.Context) error                { return u.err("load") }
func (u Unimplemented) List(context.Context) ([]User, error)      { return nil, u.err("list") }
func (u Unimplemented) Get(context.Context, string) (User, error) { return User{}, u.err("get") }
func (u Unimplemented) Authenticate(context.Context, string, string) (User, error) {
	return User{}, u.err("authenticate")
}
func (u Unimplemented) Add(context.Context, User) error      { return u.err("add") }
func (u Unimplemented) Update(context.Context, User) error   { return u.err("update") }
func (u Unimplemented) Delete(context.Context, string) error { return u.err("delete") }
func (u Unimplemented) Close() error                         { return nil }
