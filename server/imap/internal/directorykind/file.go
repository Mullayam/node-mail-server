package directorykind

import (
	"context"
	"crypto/subtle"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"

	"imap/internal/quota"
)

// The "file" kind reads users from an XML file:
//
//	<directory kind="file" source="/etc/imap/users.xml"/>
//
// Reading and reloading work. Add, Update and Delete are stubs: edit
// users.xml and run "imapctl reload" instead, or implement them below.
func init() {
	Register("file", func(opts map[string]string) (Directory, error) {
		src := opts["source"]
		if src == "" {
			return nil, errors.New(`file directory: <directory kind="file"> needs a source="path/to/users.xml" attribute`)
		}
		return &File{Unimplemented: Unimplemented{Kind: "file"}, Source: src}, nil
	})
}

// File is the users.xml directory.
type File struct {
	Unimplemented
	Source string

	mu    sync.RWMutex
	users map[string]User
}

type usersXML struct {
	XMLName xml.Name `xml:"users"`
	Domains []struct {
		Name  string `xml:"name,attr"`
		IMAP  string `xml:"imap,attr"`
		Users []struct {
			ID            string `xml:"id,attr"`
			Password      string `xml:"password,attr"`
			IMAP          string `xml:"imap,attr"`
			QuotaStorage  string `xml:"quota-storage,attr"`
			QuotaMessages string `xml:"quota-messages,attr"`
		} `xml:"user"`
	} `xml:"domain"`
}

// Load reads users.xml. If the file is invalid, the users already loaded stay.
func (f *File) Load(context.Context) error {
	data, err := os.ReadFile(f.Source)
	if err != nil {
		return fmt.Errorf("file directory: %w", err)
	}
	users, err := parseUsers(data)
	if err != nil {
		return fmt.Errorf("file directory %s: %w", f.Source, err)
	}
	f.mu.Lock()
	f.users = users
	f.mu.Unlock()
	return nil
}

func parseUsers(data []byte) (map[string]User, error) {
	var doc usersXML
	if err := xml.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	users := map[string]User{}
	var problems []error
	for _, d := range doc.Domains {
		domain := Normalize(d.Name)
		domainIMAP, err := parseBool(d.IMAP, false)
		if domain == "" || strings.ContainsAny(domain, "@ ") || err != nil {
			problems = append(problems, fmt.Errorf("domain %q: invalid name or imap attribute", d.Name))
			continue
		}
		for _, x := range d.Users {
			id := Normalize(x.ID)
			addr := id + "@" + domain
			imapOn, err := parseBool(x.IMAP, domainIMAP)
			switch {
			case id == "" || strings.ContainsAny(id, "@ "):
				problems = append(problems, fmt.Errorf("domain %s: user %q has an invalid id", domain, x.ID))
				continue
			case x.Password == "":
				problems = append(problems, fmt.Errorf("%s: password is empty", addr))
				continue
			case err != nil:
				problems = append(problems, fmt.Errorf("%s: %w", addr, err))
				continue
			}
			if _, dup := users[addr]; dup {
				problems = append(problems, fmt.Errorf("%s is listed twice", addr))
				continue
			}
			u := User{Address: addr, Password: x.Password, IMAP: imapOn}
			if x.QuotaStorage != "" || x.QuotaMessages != "" {
				var l quota.Limit
				var e1, e2 error
				l.StorageBytes, e1 = quota.ParseSize(x.QuotaStorage)
				l.Messages, e2 = quota.ParseCount(x.QuotaMessages)
				if err := errors.Join(e1, e2); err != nil {
					problems = append(problems, fmt.Errorf("%s: %w", addr, err))
					continue
				}
				u.Quota = &l
			}
			users[addr] = u
		}
	}
	return users, errors.Join(problems...)
}

func parseBool(s string, def bool) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "":
		return def, nil
	case "true", "yes", "on", "1":
		return true, nil
	case "false", "no", "off", "0":
		return false, nil
	}
	return false, fmt.Errorf("imap=%q: want true or false", s)
}

func (f *File) List(context.Context) ([]User, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	out := make([]User, 0, len(f.users))
	for _, u := range f.users {
		out = append(out, u)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Address < out[j].Address })
	return out, nil
}

func (f *File) Get(_ context.Context, address string) (User, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	u, ok := f.users[Normalize(address)]
	if !ok {
		return User{}, ErrNotFound
	}
	return u, nil
}

// Authenticate compares plain-text passwords (prototype only). The comparison
// takes the same time whether or not the user exists.
func (f *File) Authenticate(ctx context.Context, address, password string) (User, error) {
	u, err := f.Get(ctx, address)
	want := u.Password
	if err != nil {
		want = "\x00no-such-user\x00"
	}
	if subtle.ConstantTimeCompare([]byte(want), []byte(password)) != 1 || err != nil {
		return User{}, ErrBadCredentials
	}
	return u, nil
}

// Add, Update and Delete are stubs for the file kind. To implement them:
// change f.users under f.mu, write the whole map back to f.Source as XML
// (write to a temp file, then rename it over the old one), and return nil.
// The router already calls Sync afterwards, so Gluon picks up the change.
func (f *File) Add(context.Context, User) error {
	return f.err("add (edit users.xml, then imapctl reload)")
}
func (f *File) Update(context.Context, User) error {
	return f.err("update (edit users.xml, then imapctl reload)")
}
func (f *File) Delete(context.Context, string) error {
	return f.err("delete (edit users.xml, then imapctl reload)")
}
