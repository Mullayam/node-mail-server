package kv

import (
	"errors"
	"testing"
)

// Every driver must pass the same suite. Add new drivers here.
func drivers(t *testing.T) map[string]Store {
	t.Helper()
	p, err := OpenPebble(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return map[string]Store{"pebble": p}
}

func TestStore(t *testing.T) {
	for name, s := range drivers(t) {
		t.Run(name, func(t *testing.T) {
			if _, err := s.Get(Key("nope")); !errors.Is(err, ErrNotFound) {
				t.Fatalf("missing key: %v", err)
			}
			if err := s.Set(Key("a", "1"), []byte("one")); err != nil {
				t.Fatal(err)
			}
			if v, _ := s.Get(Key("a", "1")); string(v) != "one" {
				t.Fatalf("get = %q", v)
			}

			// Prefix scans see only their own children, in order.
			s.Set(Key("a", "2"), []byte("two"))
			s.Set(Key("ab", "x"), []byte("other prefix"))
			keys, _ := Keys(s, Prefix("a"))
			if len(keys) != 2 || LastPart(keys[0]) != "1" || LastPart(keys[1]) != "2" {
				t.Fatalf("scan = %q", keys)
			}

			// A failed batch writes nothing.
			boom := errors.New("boom")
			err := s.Batch(func(b Batch) error {
				b.Set(Key("a", "3"), []byte("three"))
				return boom
			})
			if !errors.Is(err, boom) {
				t.Fatal(err)
			}
			if ok, _ := Has(s, Key("a", "3")); ok {
				t.Fatal("failed batch was applied")
			}

			// JSON helpers and prefix delete.
			type rec struct{ N int }
			if err := SetJSON(s, Key("j"), rec{N: 7}); err != nil {
				t.Fatal(err)
			}
			if r, err := GetJSON[rec](s, Key("j")); err != nil || r.N != 7 {
				t.Fatalf("json = %+v %v", r, err)
			}
			n, err := DeletePrefix(s, s, Prefix("a"))
			if err != nil || n != 2 {
				t.Fatalf("delete prefix = %d %v", n, err)
			}
			if ok, _ := Has(s, Key("ab", "x")); !ok {
				t.Fatal("delete prefix removed a key from another prefix")
			}
		})
	}
}
