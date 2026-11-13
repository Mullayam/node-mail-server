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

func TestFileWritesPersist(t *testing.T) {
	ctx := context.Background()
	src, _ := os.ReadFile("../../conf/users.example.xml")
	path := filepath.Join(t.TempDir(), "users.xml")
	os.WriteFile(path, src, 0o600)
	d, _ := Open("file", map[string]string{"source": path})
	if err := d.Load(ctx); err != nil {
		t.Fatal(err)
	}

	if err := d.Add(ctx, User{Address: "Carol@Example.org", Password: "pw", IMAP: true}); err != nil {
		t.Fatal(err)
	}
	if err := d.Add(ctx, User{Address: "carol@example.org", Password: "pw"}); !errors.Is(err, ErrExists) {
		t.Errorf("duplicate add: %v", err)
	}
	if err := d.Add(ctx, User{Address: "no-at-sign", Password: "pw"}); err == nil {
		t.Error("an address without @ should be refused")
	}
	u, _ := d.Get(ctx, "bob@example.org")
	u.IMAP = true
	if err := d.Update(ctx, u); err != nil {
		t.Fatal(err)
	}
	if err := d.Delete(ctx, "noreply@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := d.Delete(ctx, "ghost@example.com"); !errors.Is(err, ErrNotFound) {
		t.Errorf("delete unknown: %v", err)
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Errorf("no backup written: %v", err)
	}

	// A fresh directory reads back exactly what was written.
	again, _ := Open("file", map[string]string{"source": path})
	if err := again.Load(ctx); err != nil {
		t.Fatalf("written file does not load: %v", err)
	}
	for addr, imap := range map[string]bool{"carol@example.org": true, "bob@example.org": true, "user1@example.com": true} {
		got, err := again.Get(ctx, addr)
		if err != nil || got.IMAP != imap {
			t.Errorf("%s: %+v %v", addr, got, err)
		}
	}
	if _, err := again.Get(ctx, "noreply@example.com"); !errors.Is(err, ErrNotFound) {
		t.Error("deleted user came back")
	}
	if got, _ := again.Get(ctx, "user1@example.com"); got.Quota == nil || got.Quota.StorageBytes != 2<<30 {
		t.Errorf("quota lost on rewrite: %+v", got.Quota)
	}
	if _, err := again.Authenticate(ctx, "carol@example.org", "pw"); err != nil {
		t.Errorf("new user cannot log in: %v", err)
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
