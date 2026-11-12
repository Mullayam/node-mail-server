package storage

import "errors"

// The "dir" engine is a placeholder for keeping mail in folders on disk:
//
//	<storage engine="dir" path="/data/mail"/>
//
// A real version could use one Maildir per account and mailbox, for example
// <path>/<domain>/<user>/<mailbox>/{cur,new,tmp}, with the message ID as the
// file name. Every method returns ErrNotImplemented for now.
func init() {
	Register("dir", func(opts map[string]string) (Engine, error) {
		if opts["path"] == "" {
			return nil, errors.New(`dir storage: <storage engine="dir"> needs a path="..." attribute`)
		}
		return &Dir{Unimplemented: Unimplemented{Engine: "dir"}, Path: opts["path"]}, nil
	})
}

// Dir is the placeholder on-disk engine.
type Dir struct {
	Unimplemented
	Path string
}
