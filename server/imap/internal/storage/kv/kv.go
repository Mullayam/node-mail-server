// Package kv is the reusable key-value layer the storage engine is built on.
//
// A Store is anything with Get, Set, Delete, prefix Scan and atomic Batch.
// Two drivers ship with it: Pebble (on disk) and Memory (tests). The helpers
// below (Key, GetJSON, SetJSON, Keys, DeletePrefix) are what the engine uses
// for every operation, so a new driver only has to implement Store.
package kv

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

// ErrNotFound is returned by Get when the key does not exist.
var ErrNotFound = errors.New("kv: key not found")

// Reader reads keys.
type Reader interface {
	// Get returns a copy of the value, or ErrNotFound.
	Get(key []byte) ([]byte, error)
	// Scan calls fn for every key that starts with prefix, in key order.
	// key and value are only valid during the call.
	Scan(prefix []byte, fn func(key, value []byte) error) error
}

// Writer writes keys.
type Writer interface {
	Set(key, value []byte) error
	Delete(key []byte) error
}

// Batch collects writes that are applied together.
type Batch interface{ Writer }

// Store is a key-value database.
type Store interface {
	Reader
	Writer
	// Batch applies every write made in fn at once, or none if fn fails.
	Batch(fn func(b Batch) error) error
	Close() error
}

// sep separates key parts. Parts never contain it, so ("a","bc") and
// ("ab","c") produce different keys.
const sep = "\x00"

// Key joins parts into one key.
func Key(parts ...string) []byte { return []byte(strings.Join(parts, sep)) }

// Prefix is Key plus a trailing separator: it matches the children of parts.
func Prefix(parts ...string) []byte { return append(Key(parts...), sep...) }

// LastPart returns the part after the last separator.
func LastPart(key []byte) string {
	if i := bytes.LastIndex(key, []byte(sep)); i >= 0 {
		return string(key[i+1:])
	}
	return string(key)
}

// Has reports whether key exists.
func Has(r Reader, key []byte) (bool, error) {
	_, err := r.Get(key)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, ErrNotFound):
		return false, nil
	default:
		return false, err
	}
}

// GetJSON reads and decodes a JSON value.
func GetJSON[T any](r Reader, key []byte) (T, error) {
	var v T
	raw, err := r.Get(key)
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
}

// SetJSON encodes and writes a JSON value. It works on a Store or a Batch.
func SetJSON(w Writer, key []byte, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return w.Set(key, raw)
}

// Keys returns copies of every key under prefix.
func Keys(r Reader, prefix []byte) ([][]byte, error) {
	var out [][]byte
	err := r.Scan(prefix, func(k, _ []byte) error {
		out = append(out, bytes.Clone(k))
		return nil
	})
	return out, err
}

// DeletePrefix deletes every key under prefix through w and returns how many.
func DeletePrefix(r Reader, w Writer, prefix []byte) (int, error) {
	keys, err := Keys(r, prefix)
	if err != nil {
		return 0, err
	}
	for _, k := range keys {
		if err := w.Delete(k); err != nil {
			return 0, err
		}
	}
	return len(keys), nil
}

// prefixEnd returns the smallest key greater than every key with this prefix,
// or nil when there is none (prefix is all 0xff).
func prefixEnd(prefix []byte) []byte {
	end := bytes.Clone(prefix)
	for i := len(end) - 1; i >= 0; i-- {
		if end[i] < 0xff {
			end[i]++
			return end[:i+1]
		}
	}
	return nil
}
