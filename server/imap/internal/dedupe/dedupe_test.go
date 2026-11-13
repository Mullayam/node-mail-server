package dedupe

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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

func claim(t *testing.T, s *Store, account, id string) (Outcome, string) {
	t.Helper()
	o, stored, err := s.Claim(context.Background(), account, id)
	if err != nil {
		t.Fatal(err)
	}
	return o, stored
}

func deliver(t *testing.T, s *Store, account, id, stored string) {
	t.Helper()
	if o, _ := claim(t, s, account, id); o != Claimed {
		t.Fatalf("claim %s/%s = %v, want Claimed", account, id, o)
	}
	if err := s.Complete(context.Background(), account, id, stored); err != nil {
		t.Fatal(err)
	}
}

func TestClaimLifecycle(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)

	if o, _ := claim(t, s, "a@x.org", "<1@x>"); o != Claimed {
		t.Fatalf("first claim = %v", o)
	}
	if o, _ := claim(t, s, "a@x.org", "<1@x>"); o != InFlight {
		t.Fatalf("claim while the first is running = %v, want InFlight", o)
	}
	if err := s.Complete(ctx, "a@x.org", "<1@x>", "id-1"); err != nil {
		t.Fatal(err)
	}
	if o, id := claim(t, s, "a@x.org", "<1@x>"); o != Duplicate || id != "id-1" {
		t.Fatalf("claim after completion = %v %q, want Duplicate id-1", o, id)
	}
	if o, _ := claim(t, s, "b@x.org", "<1@x>"); o != Claimed {
		t.Fatalf("another user must not be affected, got %v", o)
	}
}

func TestNoMessageIDIsNeverTracked(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)
	for range 3 {
		if o, _ := claim(t, s, "a@x.org", ""); o != Claimed {
			t.Fatalf("a message without Message-ID must always be stored, got %v", o)
		}
	}
	if err := s.Complete(ctx, "a@x.org", "", "id"); err != nil {
		t.Fatal(err)
	}
	if err := s.Release(ctx, "a@x.org", ""); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM delivered`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows = %d, err %v; want 0", n, err)
	}
}

func TestReleaseFreesAFailedDelivery(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)
	claim(t, s, "a@x.org", "<1@x>")
	if err := s.Release(ctx, "a@x.org", "<1@x>"); err != nil {
		t.Fatal(err)
	}
	if o, _ := claim(t, s, "a@x.org", "<1@x>"); o != Claimed {
		t.Fatalf("after a failed delivery the retry must be allowed, got %v", o)
	}

	deliver(t, s, "a@x.org", "<2@x>", "id-2")
	if err := s.Release(ctx, "a@x.org", "<2@x>"); err != nil {
		t.Fatal(err)
	}
	if o, _ := claim(t, s, "a@x.org", "<2@x>"); o != Duplicate {
		t.Fatalf("release must not drop a completed record, got %v", o)
	}
}

func TestOnlyOneConcurrentClaimWins(t *testing.T) {
	s, _ := open(t, time.Hour)
	const n = 50
	var wg sync.WaitGroup
	outcomes := make(chan Outcome, n)
	start := make(chan struct{})
	for range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			o, _, err := s.Claim(context.Background(), "a@x.org", "<same@x>")
			if err != nil {
				t.Error(err)
			}
			outcomes <- o
		}()
	}
	close(start)
	wg.Wait()
	close(outcomes)

	counts := map[Outcome]int{}
	for o := range outcomes {
		counts[o]++
	}
	if counts[Claimed] != 1 || counts[InFlight] != n-1 {
		t.Fatalf("outcomes = %v, want exactly one Claimed and %d InFlight", counts, n-1)
	}
}

func TestSurvivesRestart(t *testing.T) {
	s, path := open(t, time.Hour)
	deliver(t, s, "a@x.org", "<1@x>", "id-1")
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	again, err := Open(path, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if o, id := claim(t, again, "a@x.org", "<1@x>"); o != Duplicate || id != "id-1" {
		t.Fatalf("record lost over a restart: %v %q", o, id)
	}
}

func TestForgetByStoredID(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)
	deliver(t, s, "a@x.org", "<1@x>", "id-1")
	deliver(t, s, "a@x.org", "<2@x>", "id-2")
	deliver(t, s, "b@x.org", "<1@x>", "id-1")
	claim(t, s, "a@x.org", "<running@x>")

	if err := s.Forget(ctx, "a@x.org", "id-1", ""); err != nil {
		t.Fatal(err)
	}
	if o, _ := claim(t, s, "a@x.org", "<1@x>"); o != Claimed {
		t.Fatalf("a deleted message must not block a new delivery, got %v", o)
	}
	if o, _ := claim(t, s, "a@x.org", "<2@x>"); o != Duplicate {
		t.Fatalf("other messages must be kept, got %v", o)
	}
	if o, _ := claim(t, s, "b@x.org", "<1@x>"); o != Duplicate {
		t.Fatalf("another user's record must be kept, got %v", o)
	}
	if o, _ := claim(t, s, "a@x.org", "<running@x>"); o != InFlight {
		t.Fatalf("a delivery in progress must not be forgotten, got %v", o)
	}
	if err := s.Forget(ctx, "a@x.org"); err != nil {
		t.Fatalf("forgetting nothing: %v", err)
	}
}

func TestExpiryAndStaleClaims(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, time.Hour)
	now := time.Now()
	s.now = func() time.Time { return now }

	deliver(t, s, "a@x.org", "<done@x>", "id-1")
	claim(t, s, "a@x.org", "<abandoned@x>")

	now = now.Add(s.lease + time.Minute)
	if o, _ := claim(t, s, "a@x.org", "<abandoned@x>"); o != Claimed {
		t.Fatalf("a claim left behind by a crash must be reclaimable after the lease, got %v", o)
	}
	if o, _ := claim(t, s, "a@x.org", "<done@x>"); o != Duplicate {
		t.Fatalf("a completed record is kept for the ttl, got %v", o)
	}

	now = now.Add(time.Hour)
	if o, _ := claim(t, s, "a@x.org", "<done@x>"); o != Claimed {
		t.Fatalf("a completed record must expire after the ttl, got %v", o)
	}

	now = now.Add(2 * time.Hour)
	n, err := s.Prune(ctx)
	if err != nil || n != 2 {
		t.Fatalf("prune removed %d rows, err %v; want 2", n, err)
	}
}

func TestPruneDropsAbandonedClaimsEarly(t *testing.T) {
	ctx := context.Background()
	s, _ := open(t, 24*time.Hour)
	now := time.Now()
	s.now = func() time.Time { return now }

	deliver(t, s, "a@x.org", "<done@x>", "id-1")
	claim(t, s, "a@x.org", "<abandoned@x>")

	now = now.Add(s.lease + time.Minute)
	n, err := s.Prune(ctx)
	if err != nil || n != 1 {
		t.Fatalf("prune removed %d rows, err %v; want only the abandoned claim", n, err)
	}
	if o, _ := claim(t, s, "a@x.org", "<done@x>"); o != Duplicate {
		t.Fatalf("the completed record must stay, got %v", o)
	}
}

func TestMessageIsUniquePerAccount(t *testing.T) {
	s, _ := open(t, time.Hour)
	insert := `INSERT INTO delivered (account, message_id, stored_id, at) VALUES (?, ?, ?, ?)`
	if _, err := s.db.Exec(insert, "a@x.org", "<1@x>", "id-1", 1); err != nil {
		t.Fatal(err)
	}
	_, err := s.db.Exec(insert, "a@x.org", "<1@x>", "id-2", 1)
	if err == nil || !strings.Contains(err.Error(), "UNIQUE") {
		t.Fatalf("the database must refuse a second row for the same account and Message-ID, got %v", err)
	}
	if _, err := s.db.Exec(insert, "b@x.org", "<1@x>", "id-3", 1); err != nil {
		t.Fatalf("the same Message-ID for another account is allowed: %v", err)
	}
}

func TestStatementsUseIndexes(t *testing.T) {
	s, _ := open(t, time.Hour)
	const pk = "USING PRIMARY KEY (account=? AND message_id=?)"
	queries := []struct {
		sql  string
		args []any
		want string
	}{
		{lookupSQL, []any{"a", "m"}, pk},
		{completeSQL, []any{"id", 1, "a", "m"}, pk},
		{releaseSQL, []any{"a", "m"}, pk},
		{forgetSQL, []any{"a", "id"}, "USING INDEX delivered_stored (account=? AND stored_id=?)"},
		{pruneRecords, []any{1}, "USING INDEX delivered_at (at<?)"},
		{pruneClaims, []any{1}, "USING INDEX delivered_at (at<?)"},
	}
	for _, c := range queries {
		q := c.sql
		rows, err := s.db.Query("EXPLAIN QUERY PLAN "+q, c.args...)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
		}
		rows.Close()
		joined := strings.Join(plan, " | ")
		if !strings.Contains(joined, c.want) || strings.Contains(joined, "SCAN") {
			t.Errorf("%q\n  plan: %s\n  want: %s", strings.Join(strings.Fields(q), " "), joined, c.want)
		}
		t.Logf("%-60.60s -> %s", strings.Join(strings.Fields(q), " "), joined)
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

func fill(b *testing.B, s *Store, rows int, at int64) {
	b.Helper()
	tx, err := s.db.Begin()
	if err != nil {
		b.Fatal(err)
	}
	stmt, err := tx.Prepare(`INSERT INTO delivered (account, message_id, stored_id, at) VALUES (?, ?, ?, ?)`)
	if err != nil {
		b.Fatal(err)
	}
	for i := range rows {
		if _, err := stmt.Exec(fmt.Sprintf("u%d@x.org", i%1000), fmt.Sprintf("<%d@x>", i), fmt.Sprintf("id-%d", i), at); err != nil {
			b.Fatal(err)
		}
	}
	stmt.Close()
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	if _, err := s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		b.Fatal(err)
	}
}

func bigStore(b *testing.B) *Store {
	b.Helper()
	s, err := Open(filepath.Join(b.TempDir(), "dedupe.db"), 24*time.Hour)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { s.Close() })
	fill(b, s, 200_000, s.now().Unix())
	return s
}

func BenchmarkClaimAndCompleteNew(b *testing.B) {
	s, ctx, i := bigStore(b), context.Background(), 0
	for b.Loop() {
		i++
		id := fmt.Sprintf("<new-%d@x>", i)
		if o, _, err := s.Claim(ctx, "u7@x.org", id); err != nil || o != Claimed {
			b.Fatal(o, err)
		}
		if err := s.Complete(ctx, "u7@x.org", id, "stored"); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkClaimDuplicate(b *testing.B) {
	s, ctx := bigStore(b), context.Background()
	for b.Loop() {
		if o, _, err := s.Claim(ctx, "u7@x.org", "<7@x>"); err != nil || o != Duplicate {
			b.Fatal(o, err)
		}
	}
}

func BenchmarkForget(b *testing.B) {
	s, ctx, i := bigStore(b), context.Background(), 0
	for b.Loop() {
		if err := s.Forget(ctx, fmt.Sprintf("u%d@x.org", i%1000), fmt.Sprintf("id-%d", i)); err != nil {
			b.Fatal(err)
		}
		i++
	}
}

func BenchmarkClaimParallel(b *testing.B) {
	s, ctx := bigStore(b), context.Background()
	var n atomic.Int64
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			id := fmt.Sprintf("<p-%d@x>", n.Add(1))
			if o, _, err := s.Claim(ctx, "u9@x.org", id); err != nil || o != Claimed {
				b.Fatal(o, err)
			}
			if err := s.Complete(ctx, "u9@x.org", id, "stored"); err != nil {
				b.Fatal(err)
			}
		}
	})
}

func TestPruneLargeTable(t *testing.T) {
	if testing.Short() {
		t.Skip("large table")
	}
	s, _ := open(t, time.Hour)
	tx, _ := s.db.Begin()
	stmt, _ := tx.Prepare(`INSERT INTO delivered (account, message_id, stored_id, at) VALUES (?, ?, ?, ?)`)
	old := s.now().Add(-2 * time.Hour).Unix()
	for i := range 200_000 {
		at := old
		if i%2 == 0 {
			at = s.now().Unix()
		}
		stmt.Exec(fmt.Sprintf("u%d@x.org", i%1000), fmt.Sprintf("<%d@x>", i), fmt.Sprintf("id-%d", i), at)
	}
	stmt.Close()
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	n, err := s.Prune(context.Background())
	took := time.Since(start)
	if err != nil || n != 100_000 {
		t.Fatalf("pruned %d, err %v; want 100000", n, err)
	}
	t.Logf("pruned 100000 of 200000 rows in %s", took)
	if o, _ := claim(t, s, "u0@x.org", "<0@x>"); o != Duplicate {
		t.Fatalf("a fresh row must survive the prune, got %v", o)
	}
}
