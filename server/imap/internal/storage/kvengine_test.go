package storage

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"imap/internal/quota"
)

func TestKVEngineLifecycle(t *testing.T) {
	for _, name := range []string{"pebble"} {
		t.Run(name, func(t *testing.T) {
			e, err := Open(name, map[string]string{"path": t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			defer e.Close()
			ctx, a := context.Background(), "user@example.com"

			inbox, _ := e.CreateMailbox(ctx, a, []string{"INBOX"})
			archive, _ := e.CreateMailbox(ctx, a, []string{"Archive"})
			if boxes, _ := e.ListMailboxes(ctx, a); len(boxes) != 2 {
				t.Fatalf("mailboxes = %+v", boxes)
			}

			m1, err := e.CreateMessage(ctx, a, inbox, []byte("hello"), []string{`\Seen`}, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			m2, _ := e.CreateMessage(ctx, a, inbox, []byte("world!!"), nil, time.Now())
			if u, _ := e.Usage(ctx, a); u != (quota.Usage{StorageBytes: 12, Messages: 2}) {
				t.Fatalf("usage = %+v", u)
			}
			if body, _ := e.GetMessage(ctx, a, m1); string(body) != "hello" {
				t.Fatalf("body = %q", body)
			}

			if err := e.AddToMailbox(ctx, a, []string{m1}, archive); err != nil {
				t.Fatal(err)
			}
			if err := e.RemoveFromMailbox(ctx, a, []string{m1}, inbox); err != nil {
				t.Fatal(err)
			}
			if _, err := e.GetMessage(ctx, a, m1); err != nil {
				t.Fatalf("m1 should survive while it is in Archive: %v", err)
			}

			if err := e.MoveMessages(ctx, a, []string{m2}, inbox, archive); err != nil {
				t.Fatal(err)
			}
			if msgs, _ := e.ListMessages(ctx, a, inbox); len(msgs) != 0 {
				t.Fatalf("INBOX should be empty: %+v", msgs)
			}
			e.SetFlag(ctx, a, []string{m2}, `\Flagged`, true)
			msgs, _ := e.ListMessages(ctx, a, archive)
			if len(msgs) != 2 {
				t.Fatalf("Archive = %+v", msgs)
			}
			for _, m := range msgs {
				if m.ID == m2 && !slices.Contains(m.Flags, `\Flagged`) {
					t.Fatalf("flag not set: %+v", m)
				}
			}

			if err := e.DeleteMailbox(ctx, a, archive); err != nil {
				t.Fatal(err)
			}
			if _, err := e.GetMessage(ctx, a, m1); !errors.Is(err, ErrMessageNotFound) {
				t.Fatalf("m1 should be gone: %v", err)
			}
			if u, _ := e.Usage(ctx, a); u != (quota.Usage{}) {
				t.Fatalf("usage after delete = %+v", u)
			}

			if boxes, _ := e.ListMailboxes(ctx, "other@example.com"); len(boxes) != 0 {
				t.Fatalf("other account sees %+v", boxes)
			}
			if _, err := e.CreateMessage(ctx, a, "missing", []byte("x"), nil, time.Now()); !errors.Is(err, ErrMailboxNotFound) {
				t.Fatalf("unknown mailbox: %v", err)
			}
		})
	}
}

func TestPebbleKeepsDataAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	e, _ := Open("pebble", map[string]string{"path": dir})
	box, _ := e.CreateMailbox(ctx, "a@b.c", []string{"INBOX"})
	e.CreateMessage(ctx, "a@b.c", box, []byte("persist me"), nil, time.Now())
	e.Close()

	e, _ = Open("pebble", map[string]string{"path": dir})
	defer e.Close()
	if msgs, _ := e.ListMessages(ctx, "a@b.c", box); len(msgs) != 1 {
		t.Fatalf("after reopen: %+v", msgs)
	}
}
