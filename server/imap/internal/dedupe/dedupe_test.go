package dedupe

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func open(t *testing.T, ttl time.Duration) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "dedupe.db")
	s, err := Open(path, ttl)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path
}

func TestSeenAndRemember(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)

	if _, ok, err := s.Seen(ctx, "a@x.org", "<1@x>"); err != nil || ok {
		t.Fatalf("nothing delivered yet: ok=%v err=%v", ok, err)
	}
	if err := s.Remember(ctx, "a@x.org", "<1@x>", "id-1"); err != nil {
		t.Fatal(err)
	}
	if id, ok, err := s.Seen(ctx, "a@x.org", "<1@x>"); err != nil || !ok || id != "id-1" {
		t.Fatalf("seen = %q %v %v", id, ok, err)
	}
	if _, ok, _ := s.Seen(ctx, "b@x.org", "<1@x>"); ok {
		t.Fatal("another user must not be affected")
	}
	if _, ok, _ := s.Seen(ctx, "a@x.org", ""); ok {
		t.Fatal("a message without Message-ID is never a duplicate")
	}
	if err := s.Remember(ctx, "a@x.org", "", "id-2"); err != nil {
		t.Fatal(err)
	}
}

func TestSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	s, path := open(t, time.Hour)
	if err := s.Remember(ctx, "a@x.org", "<1@x>", "id-1"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	again, err := Open(path, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if id, ok, _ := again.Seen(ctx, "a@x.org", "<1@x>"); !ok || id != "id-1" {
		t.Fatalf("record lost over a restart: %q %v", id, ok)
	}
}

func TestForgetByStoredID(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)
	s.Remember(ctx, "a@x.org", "<1@x>", "id-1")
	s.Remember(ctx, "a@x.org", "<2@x>", "id-2")
	s.Remember(ctx, "b@x.org", "<1@x>", "id-1")

	if err := s.Forget(ctx, "a@x.org", "id-1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := s.Seen(ctx, "a@x.org", "<1@x>"); ok {
		t.Fatal("a deleted message must not block a new delivery")
	}
	if _, ok, _ := s.Seen(ctx, "a@x.org", "<2@x>"); !ok {
		t.Fatal("other messages must be kept")
	}
	if _, ok, _ := s.Seen(ctx, "b@x.org", "<1@x>"); !ok {
		t.Fatal("another user's record must be kept")
	}
	if err := s.Forget(ctx, "a@x.org"); err != nil {
		t.Fatalf("forgetting nothing: %v", err)
	}
}

func TestExpiryAndPrune(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)
	now := time.Now()
	s.now = func() time.Time { return now }
	s.Remember(ctx, "a@x.org", "<1@x>", "id-1")

	now = now.Add(30 * time.Minute)
	s.Remember(ctx, "a@x.org", "<2@x>", "id-2")

	now = now.Add(31 * time.Minute)
	if _, ok, _ := s.Seen(ctx, "a@x.org", "<1@x>"); ok {
		t.Fatal("entry should expire after the ttl")
	}
	if _, ok, _ := s.Seen(ctx, "a@x.org", "<2@x>"); !ok {
		t.Fatal("a newer entry is still inside the ttl")
	}
	n, err := s.Prune(ctx)
	if err != nil || n != 1 {
		t.Fatalf("prune removed %d rows, err %v; want 1", n, err)
	}
}

func TestRememberAgainRefreshes(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)
	s.Remember(ctx, "a@x.org", "<1@x>", "id-1")
	s.Remember(ctx, "a@x.org", "<1@x>", "id-9")
	if id, ok, _ := s.Seen(ctx, "a@x.org", "<1@x>"); !ok || id != "id-9" {
		t.Fatalf("seen = %q %v", id, ok)
	}
}

func TestMessageID(t *testing.T) {
	cases := map[string]string{
		"Message-ID: <a@b>\r\nSubject: x\r\n\r\nbody":       "<a@b>",
		"message-id:   <c@d>  \r\n\r\nbody":                 "<c@d>",
		"Subject: x\r\nMessage-ID:\r\n <folded@e>\r\n\r\nb": "<folded@e>",
		"Subject: no id\r\n\r\nMessage-ID: <in-body@f>":     "",
	}
	for msg, want := range cases {
		if got := MessageID([]byte(msg)); got != want {
			t.Errorf("MessageID(%q) = %q, want %q", msg, got, want)
		}
	}
}
