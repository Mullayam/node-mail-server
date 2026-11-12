package storage

import (
	"context"
	"errors"
	"testing"
)

func TestPlaceholderEngines(t *testing.T) {
	for name, opts := range map[string]map[string]string{"dir": {"path": "/m"}, "postgres": {"dsn": "x"}} {
		e, err := Open(name, opts)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := e.CreateMailbox(context.Background(), "a@b.c", []string{"INBOX"}); !errors.Is(err, ErrNotImplemented) {
			t.Errorf("%s: CreateMailbox err = %v", name, err)
		}
		if _, err := e.Usage(context.Background(), "a@b.c"); !errors.Is(err, ErrNotImplemented) {
			t.Errorf("%s: Usage err = %v", name, err)
		}
	}
	if _, err := Open("dir", map[string]string{}); err == nil {
		t.Error("dir without path should fail")
	}
	if _, err := Open("s3", nil); err == nil {
		t.Error("unknown engine should fail")
	}
}

// A custom engine only overrides what it supports.
type memEngine struct{ Unimplemented }

func (memEngine) CreateMailbox(context.Context, string, []string) (string, error) {
	return "mbox-1", nil
}

func TestCustomEngineRegisters(t *testing.T) {
	Register("mem-test", func(map[string]string) (Engine, error) { return memEngine{Unimplemented{Engine: "mem-test"}}, nil })
	e, err := Open("mem-test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if id, err := e.CreateMailbox(context.Background(), "a", nil); err != nil || id != "mbox-1" {
		t.Errorf("override not used: %q %v", id, err)
	}
	if _, err := e.GetMessage(context.Background(), "a", "m"); !errors.Is(err, ErrNotImplemented) {
		t.Errorf("methods it does not override should still be stubs: %v", err)
	}
}
