package router

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"imap/internal/conf"
	"imap/internal/control"
	"imap/internal/directorykind"
	"imap/internal/quota"
	"imap/internal/storage"
)

type fakeSync struct{ calls int }

func (f *fakeSync) Sync(context.Context) (any, error) { f.calls++; return "synced", nil }

// setup builds the admin router over a temp imap.xml and users.xml.
func setup(t *testing.T) (*Router, *fakeSync, string) {
	t.Helper()
	dir := t.TempDir()
	users := filepath.Join(dir, "users.xml")
	os.WriteFile(users, []byte(`<users><domain name="a.com"><user id="x" password="p" imap="true"/><user id="y" password="p"/></domain></users>`), 0o600)
	cfgPath := filepath.Join(dir, "imap.xml")
	os.WriteFile(cfgPath, []byte(`<imap><directory kind="file" source="`+filepath.ToSlash(users)+`"/><storage engine="dir" path="/m"/><quota storage="1GB"/></imap>`), 0o600)

	holder, err := conf.NewHolder(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	d, _ := directorykind.Open("file", holder.Current().Directory.Options)
	if err := d.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	engine, _ := storage.Open("dir", map[string]string{"path": "/m"})
	sync := &fakeSync{}
	r := New()
	RegisterAdmin(r, Deps{Conf: holder, Directory: d, Quota: quota.NewManager(holder.Current().Quota, engine), Gluon: sync, Version: "test", Started: time.Now()})
	return r, sync, users
}

func TestStatusAndUnknown(t *testing.T) {
	r, _, _ := setup(t)
	got, err := r.Dispatch(context.Background(), "status", nil)
	if err != nil {
		t.Fatal(err)
	}
	if s := got.(statusData); s.Users != 2 || s.IMAPEnabled != 1 {
		t.Errorf("status = %+v", s)
	}
	if _, err := r.Dispatch(context.Background(), "nope", nil); !errors.Is(err, ErrUnknownCommand) {
		t.Errorf("unknown: %v", err)
	}
}

func TestReloadAliasPicksUpUserChanges(t *testing.T) {
	r, sync, users := setup(t)
	os.WriteFile(users, []byte(`<users><domain name="a.com" imap="true"><user id="x" password="p"/><user id="y" password="p"/></domain></users>`), 0o600)
	got, err := r.Dispatch(context.Background(), "reloadxml", nil)
	if err != nil {
		t.Fatal(err)
	}
	if rd := got.(reloadData); rd.IMAPEnabled != 2 || rd.Conf.Generation != 2 {
		t.Errorf("reload = %+v", rd)
	}
	if sync.calls != 1 {
		t.Errorf("Gluon sync calls = %d, want 1", sync.calls)
	}
}

func TestUserWritesReachTheDirectory(t *testing.T) {
	r, sync, _ := setup(t)
	_, err := r.Dispatch(context.Background(), "user.add", Args{"address": "z@a.com", "password": "p", "imap": "true"})
	if !errors.Is(err, directorykind.ErrNotImplemented) {
		t.Errorf("user.add on the file kind: %v, want ErrNotImplemented", err)
	}
	if sync.calls != 0 {
		t.Error("Gluon must not be synced when the directory refused the change")
	}
	if _, err := r.Dispatch(context.Background(), "user.add", Args{"address": "z@a.com"}); err == nil || !strings.Contains(err.Error(), "password") {
		t.Errorf("missing password: %v", err)
	}
}

func TestQuotaGetShowsDefaultAndUnknownUsage(t *testing.T) {
	r, _, _ := setup(t)
	got, err := r.Dispatch(context.Background(), "quota.get", Args{"address": "x@a.com"})
	if err != nil {
		t.Fatal(err)
	}
	q := got.(quotaData)
	if q.Source != "default" || q.Limit.StorageBytes != 1<<30 || q.Usage != nil || q.Note == "" {
		t.Errorf("quota = %+v", q)
	}
}

func TestOverControlSocket(t *testing.T) {
	r, _, _ := setup(t)
	sock := filepath.Join(t.TempDir(), "c.sock")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go control.Serve(ctx, sock, func(ctx context.Context, cmd string, args map[string]string) (any, error) {
		return r.Dispatch(ctx, cmd, Args(args))
	})

	var resp *control.Response
	var err error
	for i := 0; i < 50; i++ { // wait for the socket
		if resp, err = control.Do(sock, control.Request{Command: "user.get", Args: map[string]string{"address": "x@a.com"}}, time.Second); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil || !resp.OK {
		t.Fatalf("user.get: %v %+v", err, resp)
	}
	if strings.Contains(string(resp.Data), `"p"`) || strings.Contains(string(resp.Data), "password") {
		t.Errorf("password leaked over the socket: %s", resp.Data)
	}
	bad, _ := control.Do(sock, control.Request{Command: "nope"}, time.Second)
	if bad == nil || bad.OK || !strings.Contains(bad.Error, "unknown command") {
		t.Errorf("unknown over socket: %+v", bad)
	}
}
