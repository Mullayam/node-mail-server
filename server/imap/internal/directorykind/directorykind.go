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

type User struct {
	Address  string       `json:"address"`
	Password string       `json:"-"`
	IMAP     bool         `json:"imap"`
	Quota    *quota.Limit `json:"quota,omitempty"`
}

type Directory interface {
	Load(ctx context.Context) error
	List(ctx context.Context) ([]User, error)
	Get(ctx context.Context, address string) (User, error)

	Authenticate(ctx context.Context, address, password string) (User, error)
	Add(ctx context.Context, u User) error
	Update(ctx context.Context, u User) error
	Delete(ctx context.Context, address string) error
	Close() error
}

func IMAPAllowed(u User) bool { return u.Address != "" && u.IMAP }

func Normalize(address string) string { return strings.ToLower(strings.TrimSpace(address)) }

type Factory func(options map[string]string) (Directory, error)

var (
	mu    sync.RWMutex
	kinds = map[string]Factory{}
)

func Register(kind string, f Factory) {
	mu.Lock()
	defer mu.Unlock()
	kinds[kind] = f
}

func Open(kind string, options map[string]string) (Directory, error) {
	mu.RLock()
	f, ok := kinds[kind]
	mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("unknown directory kind %q (registered: %s)", kind, strings.Join(Kinds(), ", "))
	}
	return f(options)
}

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
