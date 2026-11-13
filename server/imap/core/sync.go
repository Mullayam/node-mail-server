package factory

import (
	"context"
	"fmt"
	"sort"

	"imap/internal/directorykind"
)

type SyncReport struct {
	Loaded  []string          `json:"loaded"`
	Added   []string          `json:"added,omitempty"`
	Removed []string          `json:"removed,omitempty"`
	Failed  map[string]string `json:"failed,omitempty"`
}

func (cf *ConnectorFactory) Sync(ctx context.Context) (any, error) {
	return cf.SyncUsers(ctx)
}

func (cf *ConnectorFactory) SyncUsers(ctx context.Context) (SyncReport, error) {
	cf.mu.Lock()
	defer cf.mu.Unlock()

	users, err := cf.dir.List(ctx)
	if err != nil {
		return SyncReport{}, fmt.Errorf("list users: %w", err)
	}
	want := map[string]bool{}
	for _, u := range users {
		if directorykind.IMAPAllowed(u) {
			want[u.Address] = true
		}
	}

	r := SyncReport{Failed: map[string]string{}}

	for email, id := range cf.userConnectors {
		if want[email] {
			continue
		}
		if err := cf.server.RemoveUser(ctx, id, false); err != nil {
			r.Failed[email] = "remove: " + err.Error()
			continue
		}
		delete(cf.userConnectors, email)
		delete(cf.connectors, email)
		r.Removed = append(r.Removed, email)
	}

	for email := range want {
		if _, loaded := cf.userConnectors[email]; loaded {
			cf.ensureDefaults(ctx, cf.connectors[email])
			continue
		}
		var known *string
		if id, ok := cf.ids.get(email); ok {
			known = &id
		}
		id, err := cf.GetOrCreateUser(ctx, email, known)
		if err != nil {
			r.Failed[email] = err.Error()
			continue
		}
		if known == nil {
			if err := cf.ids.set(email, id); err != nil {
				r.Failed[email] = "save Gluon ID: " + err.Error()
			}
		}
		r.Added = append(r.Added, email)
	}

	for email := range cf.userConnectors {
		r.Loaded = append(r.Loaded, email)
	}
	sort.Strings(r.Loaded)
	sort.Strings(r.Added)
	sort.Strings(r.Removed)
	if len(r.Failed) == 0 {
		r.Failed = nil
	}
	return r, nil
}
