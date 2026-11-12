package directorykind

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openExample(t *testing.T) Directory {
	t.Helper()
	d, err := Open("file", map[string]string{"source": "../../conf/users.example.xml"})
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestIMAPRuleFromExample(t *testing.T) {
	d := openExample(t)
	ctx := context.Background()
	want := map[string]bool{
		"user1@example.com":   true,  // inherits imap="true" from the domain
		"noreply@example.com": false, // overrides the domain
		"alice@example.org":   true,  // enabled on the user
		"bob@example.org":     false, // domain default is off
	}
	users, _ := d.List(ctx)
	if len(users) != len(want) {
		t.Fatalf("got %d users, want %d", len(users), len(want))
	}
	for addr, imap := range want {
		u, err := d.Get(ctx, addr)
		if err != nil {
			t.Fatalf("%s: %v", addr, err)
		}
		if IMAPAllowed(u) != imap {
			t.Errorf("%s: IMAPAllowed = %v, want %v", addr, IMAPAllowed(u), imap)
		}
	}
	if u, _ := d.Get(ctx, "USER1@Example.com"); u.Quota == nil || u.Quota.StorageBytes != 2<<30 {
		t.Errorf("user1 quota override not read: %+v", u.Quota)
	}
}

func TestAuthenticate(t *testing.T) {
	d := openExample(t)
	ctx := context.Background()
	if _, err := d.Authenticate(ctx, "alice@example.org", "change-me"); err != nil {
		t.Errorf("valid login: %v", err)
	}
	for _, c := range [][2]string{{"alice@example.org", "wrong"}, {"nobody@example.org", "change-me"}} {
		if _, err := d.Authenticate(ctx, c[0], c[1]); !errors.Is(err, ErrBadCredentials) {
			t.Errorf("%s: err = %v, want ErrBadCredentials", c[0], err)
		}
	}
}

func TestFileWritesAreStubs(t *testing.T) {
	d := openExample(t)
	if err := d.Add(context.Background(), User{Address: "new@example.com"}); !errors.Is(err, ErrNotImplemented) {
		t.Errorf("Add err = %v, want ErrNotImplemented", err)
	}
}

func TestInvalidReloadKeepsUsers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.xml")
	os.WriteFile(path, []byte(`<users><domain name="a.com" imap="true"><user id="x" password="p"/></domain></users>`), 0o600)
	d, _ := Open("file", map[string]string{"source": path})
	if err := d.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(path, []byte(`<users><domain name="a.com"><user id="x" password=""/></domain></users>`), 0o600)
	if err := d.Load(context.Background()); err == nil {
		t.Fatal("expected an error for an empty password")
	}
	if _, err := d.Get(context.Background(), "x@a.com"); err != nil {
		t.Errorf("old users should stay after a failed load: %v", err)
	}
}

func TestOpenUnknownKindListsKinds(t *testing.T) {
	_, err := Open("ldap", nil)
	if err == nil || !strings.Contains(err.Error(), "file") || !strings.Contains(err.Error(), "postgres") {
		t.Errorf("err = %v", err)
	}
	if _, err := Open("postgres", map[string]string{"dsn": "x"}); err != nil {
		t.Errorf("postgres placeholder should open: %v", err)
	}
}
