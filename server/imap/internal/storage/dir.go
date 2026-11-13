package storage

import "errors"

func init() {
	Register("dir", func(opts map[string]string) (Engine, error) {
		if opts["path"] == "" {
			return nil, errors.New(`dir storage: <storage engine="dir"> needs a path="..." attribute`)
		}
		return &Dir{Unimplemented: Unimplemented{Engine: "dir"}, Path: opts["path"]}, nil
	})
}

type Dir struct {
	Unimplemented
	Path string
}
