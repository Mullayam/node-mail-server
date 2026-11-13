package storage

import "errors"

func init() {
	Register("postgres", func(opts map[string]string) (Engine, error) {
		if opts["dsn"] == "" {
			return nil, errors.New(`postgres storage: <storage engine="postgres"> needs a dsn="..." attribute`)
		}
		return &Postgres{Unimplemented: Unimplemented{Engine: "postgres"}, DSN: opts["dsn"]}, nil
	})
}

type Postgres struct {
	Unimplemented
	DSN string
}
