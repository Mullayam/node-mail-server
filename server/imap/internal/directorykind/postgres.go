package directorykind

import "errors"

// The "postgres" kind is a placeholder:
//
//	<directory kind="postgres" dsn="postgres://user:pass@host/mail"/>
//
// Every method returns ErrNotImplemented. A real version would read the same
// users table that SMTP AUTH uses, with an imap_enabled column and a password
// hash, so one account works for both SMTP and IMAP.
func init() {
	Register("postgres", func(opts map[string]string) (Directory, error) {
		if opts["dsn"] == "" {
			return nil, errors.New(`postgres directory: <directory kind="postgres"> needs a dsn="..." attribute`)
		}
		return &Postgres{Unimplemented: Unimplemented{Kind: "postgres"}, DSN: opts["dsn"]}, nil
	})
}

// Postgres is the placeholder Postgres directory.
type Postgres struct {
	Unimplemented
	DSN string
}
