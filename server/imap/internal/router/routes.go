package router

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"imap/internal/conf"
	"imap/internal/directorykind"
	"imap/internal/quota"
)

// Syncer brings Gluon in line with the directory: it loads users who have
// IMAP enabled and unloads the rest. core/factory implements it.
type Syncer interface {
	Sync(ctx context.Context) (any, error)
}

// CertReloader re-reads the TLS certificate. tlscert.Store implements it.
type CertReloader interface {
	Reload(certFile, keyFile string) error
	NotAfter() time.Time
}

// Deliverer stores a message for a user and pushes it to Gluon's update
// stream, so connected IMAP clients see it at once. core/factory implements it.
type Deliverer interface {
	Deliver(ctx context.Context, address, mailbox string, literal []byte) (string, error)
}

// Deps is what the admin commands work on.
type Deps struct {
	Conf      *conf.Holder
	Directory directorykind.Directory
	Quota     *quota.Manager
	Gluon     Syncer
	Mail      Deliverer    // nil disables mail.deliver
	TLS       CertReloader // nil when TLS is not configured
	Version   string
	Started   time.Time
}

// RegisterAdmin adds every admin command to r.
func RegisterAdmin(r *Router, d Deps) {
	r.Handle("routes", "routes", "list every command", func(context.Context, Args) (any, error) {
		return r.Routes(), nil
	})
	r.Handle("status", "status", "show what the server has loaded", d.status)
	r.Handle("reload", "reload", "re-read imap.xml and the users, then update Gluon", d.reload)
	r.Alias("reloadxml", "reload")

	r.Handle("user.list", "user list", "list all users", d.userList)
	r.Handle("user.get", "user get <address>", "show one user", d.userGet)
	r.Handle("user.add", "user add <address> -password P [-imap=true] [-quota-storage 1GB] [-quota-messages N]",
		"add a user", d.userAdd)
	r.Handle("user.update", "user update <address> [-password P] [-imap=true|false] [-quota-storage S] [-quota-messages N]",
		"change a user", d.userUpdate)
	r.Handle("user.delete", "user delete <address>", "delete a user", d.userDelete)

	r.Handle("quota.get", "quota get <address>", "show a user's limit and usage", d.quotaGet)
	r.Handle("quota.set", "quota set <address> [-storage S] [-messages N]", "set a user's own limit", d.quotaSet)

	r.Handle("mail.deliver", "mail deliver <address> [-mailbox NAME] < message.eml",
		"store a message (INBOX, or Junk when marked as spam) and show it to connected IMAP clients", d.mailDeliver)
}

// ---- mail ----

func (d Deps) mailDeliver(ctx context.Context, a Args) (any, error) {
	if d.Mail == nil {
		return nil, errors.New("mail delivery is not available")
	}
	addr, err := a.Require("address")
	if err != nil {
		return nil, err
	}
	msg := a["message"]
	if msg == "" {
		return nil, errors.New("missing argument \"message\" (the raw RFC 5322 message)")
	}
	// No mailbox given: filed like LMTP mail (INBOX, or Junk when a spam header says so).
	mailbox := a["mailbox"]
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	id, err := d.Mail.Deliver(ctx, addr, mailbox, []byte(msg))
	if err != nil {
		return nil, err
	}
	if mailbox == "" {
		mailbox = "auto"
	}
	return map[string]any{"address": directorykind.Normalize(addr), "mailbox": mailbox, "message_id": id, "bytes": len(msg)}, nil
}

// ---- status and reload ----

type statusData struct {
	Version     string      `json:"version"`
	Uptime      string      `json:"uptime"`
	Config      string      `json:"config"`
	Generation  uint64      `json:"generation"`
	LoadedAt    string      `json:"loaded_at"`
	Listen      string      `json:"listen"`
	TLSListen   string      `json:"tls_listen,omitempty"`
	TLSExpires  string      `json:"tls_expires,omitempty"`
	Directory   string      `json:"directory"`
	Storage     string      `json:"storage"`
	Quota       quota.Limit `json:"default_quota"`
	Users       int         `json:"users"`
	IMAPEnabled int         `json:"imap_enabled"`
}

func (d Deps) status(ctx context.Context, _ Args) (any, error) {
	cur := d.Conf.Current()
	users, err := d.Directory.List(ctx)
	if err != nil {
		return nil, err
	}
	s := statusData{
		Version:     d.Version,
		Uptime:      time.Since(d.Started).Round(time.Second).String(),
		Config:      cur.Path,
		Generation:  cur.Generation,
		LoadedAt:    cur.LoadedAt.Format(time.RFC3339),
		Listen:      cur.Listen,
		Directory:   cur.Directory.Name,
		Storage:     cur.Storage.Name,
		Quota:       cur.Quota,
		Users:       len(users),
		IMAPEnabled: countIMAP(users),
	}
	if d.TLS != nil {
		s.TLSListen = cur.TLS.Listen
		s.TLSExpires = d.TLS.NotAfter().Format(time.RFC3339)
	}
	return s, nil
}

type reloadData struct {
	Conf        *conf.ReloadReport `json:"conf"`
	TLSExpires  string             `json:"tls_expires,omitempty"`
	Users       int                `json:"users"`
	IMAPEnabled int                `json:"imap_enabled"`
	Gluon       any                `json:"gluon"`
}

// reload: imap.xml first, then the TLS certificate, then the users, then
// Gluon. If any of them is invalid, its old version stays live and the error
// says why.
func (d Deps) reload(ctx context.Context, _ Args) (any, error) {
	rep, err := d.Conf.Reload()
	if err != nil {
		return nil, err
	}
	cur := d.Conf.Current()
	d.Quota.SetDefaults(cur.Quota)

	out := reloadData{Conf: rep}
	if d.TLS != nil && cur.TLS.Enabled() {
		if err := d.TLS.Reload(cur.TLS.Cert, cur.TLS.Key); err != nil {
			return nil, fmt.Errorf("imap.xml reloaded (generation %d), but the TLS certificate was not: %w", rep.Generation, err)
		}
		out.TLSExpires = d.TLS.NotAfter().Format(time.RFC3339)
	}

	if err := d.Directory.Load(ctx); err != nil {
		return nil, fmt.Errorf("imap.xml reloaded (generation %d), but the users were not: %w", rep.Generation, err)
	}
	users, err := d.Directory.List(ctx)
	if err != nil {
		return nil, err
	}
	sync, err := d.Gluon.Sync(ctx)
	if err != nil {
		return nil, fmt.Errorf("users reloaded, but updating Gluon failed: %w", err)
	}
	out.Users, out.IMAPEnabled, out.Gluon = len(users), countIMAP(users), sync
	return out, nil
}

func countIMAP(users []directorykind.User) int {
	n := 0
	for _, u := range users {
		if directorykind.IMAPAllowed(u) {
			n++
		}
	}
	return n
}

// ---- users ----

func (d Deps) userList(ctx context.Context, _ Args) (any, error) {
	return d.Directory.List(ctx)
}

func (d Deps) userGet(ctx context.Context, a Args) (any, error) {
	addr, err := a.Require("address")
	if err != nil {
		return nil, err
	}
	return d.Directory.Get(ctx, addr)
}

func (d Deps) userAdd(ctx context.Context, a Args) (any, error) {
	addr, err := a.Require("address")
	if err != nil {
		return nil, err
	}
	if !strings.Contains(addr, "@") {
		return nil, errors.New("address must be user@domain")
	}
	pass, err := a.Require("password")
	if err != nil {
		return nil, err
	}
	u := directorykind.User{Address: directorykind.Normalize(addr), Password: pass}
	if err := applyUserArgs(&u, a); err != nil {
		return nil, err
	}
	if err := d.Directory.Add(ctx, u); err != nil {
		return nil, err
	}
	return d.afterChange(ctx, u.Address)
}

func (d Deps) userUpdate(ctx context.Context, a Args) (any, error) {
	addr, err := a.Require("address")
	if err != nil {
		return nil, err
	}
	u, err := d.Directory.Get(ctx, addr)
	if err != nil {
		return nil, err
	}
	if p := a["password"]; p != "" {
		u.Password = p
	}
	if err := applyUserArgs(&u, a); err != nil {
		return nil, err
	}
	if err := d.Directory.Update(ctx, u); err != nil {
		return nil, err
	}
	return d.afterChange(ctx, u.Address)
}

func (d Deps) userDelete(ctx context.Context, a Args) (any, error) {
	addr, err := a.Require("address")
	if err != nil {
		return nil, err
	}
	if err := d.Directory.Delete(ctx, addr); err != nil {
		return nil, err
	}
	return d.afterChange(ctx, directorykind.Normalize(addr))
}

// afterChange updates Gluon so the change takes effect immediately.
func (d Deps) afterChange(ctx context.Context, addr string) (any, error) {
	sync, err := d.Gluon.Sync(ctx)
	if err != nil {
		return nil, fmt.Errorf("%s saved, but updating Gluon failed: %w", addr, err)
	}
	return map[string]any{"address": addr, "gluon": sync}, nil
}

// applyUserArgs reads imap, quota-storage and quota-messages when present.
func applyUserArgs(u *directorykind.User, a Args) error {
	if v, ok := a["imap"]; ok && v != "" {
		switch strings.ToLower(v) {
		case "true", "yes", "on", "1":
			u.IMAP = true
		case "false", "no", "off", "0":
			u.IMAP = false
		default:
			return fmt.Errorf("imap=%q: want true or false", v)
		}
	}
	return applyQuotaArgs(u, a, "quota-storage", "quota-messages")
}

func applyQuotaArgs(u *directorykind.User, a Args, storageKey, messagesKey string) error {
	s, hasS := a[storageKey]
	m, hasM := a[messagesKey]
	if !hasS && !hasM {
		return nil
	}
	l := quota.Limit{}
	if u.Quota != nil {
		l = *u.Quota
	}
	var err error
	if hasS {
		if l.StorageBytes, err = quota.ParseSize(s); err != nil {
			return err
		}
	}
	if hasM {
		if l.Messages, err = quota.ParseCount(m); err != nil {
			return err
		}
	}
	u.Quota = &l
	return nil
}

// ---- quota ----

type quotaData struct {
	Address string       `json:"address"`
	Limit   quota.Limit  `json:"limit"`
	Source  string       `json:"source"` // "user" or "default"
	Usage   *quota.Usage `json:"usage,omitempty"`
	Note    string       `json:"note,omitempty"`
}

func (d Deps) quotaGet(ctx context.Context, a Args) (any, error) {
	addr, err := a.Require("address")
	if err != nil {
		return nil, err
	}
	u, err := d.Directory.Get(ctx, addr)
	if err != nil {
		return nil, err
	}
	out := quotaData{Address: u.Address, Limit: d.Quota.Effective(u.Quota), Source: "default"}
	if u.Quota != nil {
		out.Source = "user"
	}
	if usage, err := d.Quota.Usage(ctx, u.Address); err == nil {
		out.Usage = &usage
	} else {
		out.Note = "usage unknown: " + err.Error()
	}
	return out, nil
}

func (d Deps) quotaSet(ctx context.Context, a Args) (any, error) {
	addr, err := a.Require("address")
	if err != nil {
		return nil, err
	}
	u, err := d.Directory.Get(ctx, addr)
	if err != nil {
		return nil, err
	}
	if err := applyQuotaArgs(&u, a, "storage", "messages"); err != nil {
		return nil, err
	}
	if err := d.Directory.Update(ctx, u); err != nil {
		return nil, err
	}
	return d.quotaGet(ctx, a)
}
