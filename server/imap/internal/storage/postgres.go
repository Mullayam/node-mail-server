package storage

import "errors"

// The "postgres" engine is a placeholder for keeping mail in Postgres:
//
//	<storage engine="postgres" dsn="postgres://user:pass@host/mail"/>
//
// A real version would need tables for mailboxes, messages (or a pointer to
// object storage for large bodies), mailbox membership and flags, plus a
// usage query for quotas. Every method returns ErrNotImplemented for now.
func init() {
	Register("postgres", func(opts map[string]string) (Engine, error) {
		if opts["dsn"] == "" {
			return nil, errors.New(`postgres storage: <storage engine="postgres"> needs a dsn="..." attribute`)
		}
		return &Postgres{Unimplemented: Unimplemented{Engine: "postgres"}, DSN: opts["dsn"]}, nil
	})
}

// Postgres is the placeholder Postgres engine.
type Postgres struct {
	Unimplemented
	DSN string
}
