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
// Reading, reloading and writing all work: "imapctl user add/update/delete"
// and "imapctl quota set" save users.xml (the container needs it mounted
// read-write). Editing the file by hand and running "imapctl reload" also works.
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

// Add, Update and Delete change the users in memory and write users.xml.
// The router calls Sync afterwards, so Gluon picks up the change.

func (f *File) Add(_ context.Context, u User) error {
	return f.change(func(users map[string]User) error {
		u.Address = Normalize(u.Address)
		if err := checkUser(u); err != nil {
			return err
		}
		if _, ok := users[u.Address]; ok {
			return fmt.Errorf("%w: %s", ErrExists, u.Address)
		}
		users[u.Address] = u
		return nil
	})
}

func (f *File) Update(_ context.Context, u User) error {
	return f.change(func(users map[string]User) error {
		u.Address = Normalize(u.Address)
		if _, ok := users[u.Address]; !ok {
			return fmt.Errorf("%w: %s", ErrNotFound, u.Address)
		}
		if err := checkUser(u); err != nil {
			return err
		}
		users[u.Address] = u
		return nil
	})
}

func (f *File) Delete(_ context.Context, address string) error {
	return f.change(func(users map[string]User) error {
		addr := Normalize(address)
		if _, ok := users[addr]; !ok {
			return fmt.Errorf("%w: %s", ErrNotFound, addr)
		}
		delete(users, addr)
		return nil
	})
}

func checkUser(u User) error {
	id, domain, ok := strings.Cut(u.Address, "@")
	switch {
	case !ok || id == "" || domain == "" || strings.ContainsAny(u.Address, " \"<>") || strings.Count(u.Address, "@") != 1:
		return fmt.Errorf("invalid address %q: want user@domain", u.Address)
	case u.Password == "":
		return fmt.Errorf("%s: password is empty", u.Address)
	}
	return nil
}

// change applies fn to a copy of the users, writes the result to users.xml
// and only then makes it live. If writing fails, nothing changes.
func (f *File) change(fn func(map[string]User) error) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	next := make(map[string]User, len(f.users))
	for k, v := range f.users {
		next[k] = v
	}
	if err := fn(next); err != nil {
		return err
	}
	if err := f.write(next); err != nil {
		return fmt.Errorf("file directory: write %s: %w", f.Source, err)
	}
	f.users = next
	return nil
}

// write saves users.xml. The previous file is kept as users.xml.bak, and the
// new one is written to a temp file and renamed into place, so a crash never
// leaves a half-written file. Comments in the old file are not kept.
func (f *File) write(users map[string]User) error {
	byDomain := map[string][]User{}
	for _, u := range users {
		_, domain, _ := strings.Cut(u.Address, "@")
		byDomain[domain] = append(byDomain[domain], u)
	}
	domains := make([]string, 0, len(byDomain))
	for d := range byDomain {
		domains = append(domains, d)
	}
	sort.Strings(domains)

	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	b.WriteString("<!-- Written by imapctl. Editing by hand is fine: run \"imapctl reload\" afterwards. -->\n<users>\n")
	for _, d := range domains {
		fmt.Fprintf(&b, "  <domain name=%s>\n", xmlAttr(d))
		list := byDomain[d]
		sort.Slice(list, func(i, j int) bool { return list[i].Address < list[j].Address })
		for _, u := range list {
			id, _, _ := strings.Cut(u.Address, "@")
			fmt.Fprintf(&b, "    <user id=%s password=%s imap=\"%t\"", xmlAttr(id), xmlAttr(u.Password), u.IMAP)
			if u.Quota != nil {
				fmt.Fprintf(&b, " quota-storage=%s quota-messages=\"%d\"", xmlAttr(quota.FormatSize(u.Quota.StorageBytes)), u.Quota.Messages)
			}
			b.WriteString("/>\n")
		}
		b.WriteString("  </domain>\n")
	}
	b.WriteString("</users>\n")

	if old, err := os.ReadFile(f.Source); err == nil {
		if err := os.WriteFile(f.Source+".bak", old, 0o600); err != nil {
			return err
		}
	}
	tmp := f.Source + ".tmp"
	if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.Source)
}

// xmlAttr quotes and escapes an attribute value.
func xmlAttr(s string) string {
	var b strings.Builder
	xml.EscapeText(&b, []byte(s))
	return `"` + strings.ReplaceAll(b.String(), `"`, "&#34;") + `"`
}
