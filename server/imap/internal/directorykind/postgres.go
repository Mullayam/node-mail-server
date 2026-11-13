package directorykind

import "errors"

func init() {
	Register("postgres", func(opts map[string]string) (Directory, error) {
		if opts["dsn"] == "" {
			return nil, errors.New(`postgres directory: <directory kind="postgres"> needs a dsn="..." attribute`)
		}
		return &Postgres{Unimplemented: Unimplemented{Kind: "postgres"}, DSN: opts["dsn"]}, nil
	})
}

type Postgres struct {
	Unimplemented
	DSN string
}
