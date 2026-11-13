package kv

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
)

var ErrNotFound = errors.New("kv: key not found")

type Reader interface {
	Get(key []byte) ([]byte, error)

	Scan(prefix []byte, fn func(key, value []byte) error) error
}

type Writer interface {
	Set(key, value []byte) error
	Delete(key []byte) error
}

type Batch interface{ Writer }

type Store interface {
	Reader
	Writer

	Batch(fn func(b Batch) error) error
	Close() error
}

const sep = "\x00"

func Key(parts ...string) []byte { return []byte(strings.Join(parts, sep)) }

func Prefix(parts ...string) []byte { return append(Key(parts...), sep...) }

func LastPart(key []byte) string {
	if i := bytes.LastIndex(key, []byte(sep)); i >= 0 {
		return string(key[i+1:])
	}
	return string(key)
}

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

func GetJSON[T any](r Reader, key []byte) (T, error) {
	var v T
	raw, err := r.Get(key)
	if err != nil {
		return v, err
	}
	err = json.Unmarshal(raw, &v)
	return v, err
}

func SetJSON(w Writer, key []byte, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return w.Set(key, raw)
}

func Keys(r Reader, prefix []byte) ([][]byte, error) {
	var out [][]byte
	err := r.Scan(prefix, func(k, _ []byte) error {
		out = append(out, bytes.Clone(k))
		return nil
	})
	return out, err
}

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
