package dedupe

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/textproto"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

const schema = `
CREATE TABLE IF NOT EXISTS delivered (
	account    TEXT    NOT NULL,
	message_id TEXT    NOT NULL,
	stored_id  TEXT    NOT NULL,
	at         INTEGER NOT NULL,
	PRIMARY KEY (account, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS delivered_stored ON delivered (account, stored_id);
CREATE INDEX IF NOT EXISTS delivered_at ON delivered (at);
`

const (
	claimSQL = `INSERT INTO delivered (account, message_id, stored_id, at) VALUES (?, ?, '', ?)
		ON CONFLICT (account, message_id) DO UPDATE SET stored_id = '', at = excluded.at
		WHERE (delivered.stored_id <> '' AND delivered.at < ?)
		   OR (delivered.stored_id =  '' AND delivered.at < ?)`
	lookupSQL   = `SELECT stored_id FROM delivered WHERE account = ? AND message_id = ?`
	completeSQL = `UPDATE delivered SET stored_id = ?, at = ? WHERE account = ? AND message_id = ?`
	releaseSQL  = `DELETE FROM delivered WHERE account = ? AND message_id = ? AND stored_id = ''`
	forgetSQL   = `DELETE FROM delivered INDEXED BY delivered_stored WHERE account = ? AND stored_id = ?`
)

type Outcome int

const (
	Claimed Outcome = iota
	Duplicate
	InFlight
)

const DefaultLease = 5 * time.Minute

type Store struct {
	db    *sql.DB
	ttl   time.Duration
	lease time.Duration
	now   func() time.Time
	stop  chan struct{}
	once  sync.Once
}

func Open(path string, ttl time.Duration) (*Store, error) {
	db, err := sql.Open("sqlite3", "file:"+path+"?_busy_timeout=5000&_journal_mode=WAL&_synchronous=NORMAL")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("prepare %s: %w", path, err)
	}
	s := &Store{db: db, ttl: ttl, lease: DefaultLease, now: time.Now, stop: make(chan struct{})}
	if _, err := s.Prune(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	go s.prune(time.Hour)
	return s, nil
}

func (s *Store) Claim(ctx context.Context, account, messageID string) (Outcome, string, error) {
	if messageID == "" {
		return Claimed, "", nil
	}
	for range 3 {
		res, err := s.db.ExecContext(ctx, claimSQL,
			account, messageID, s.now().Unix(), s.recordCutoff(), s.leaseCutoff())
		if err != nil {
			return Claimed, "", err
		}
		if n, err := res.RowsAffected(); err != nil {
			return Claimed, "", err
		} else if n > 0 {
			return Claimed, "", nil
		}

		var id string
		err = s.db.QueryRowContext(ctx, lookupSQL, account, messageID).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return Claimed, "", err
		}
		if id == "" {
			return InFlight, "", nil
		}
		return Duplicate, id, nil
	}
	return Claimed, "", errors.New("the delivered-message record kept changing while it was read")
}

func (s *Store) Complete(ctx context.Context, account, messageID, storedID string) error {
	if messageID == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, completeSQL, storedID, s.now().Unix(), account, messageID)
	return err
}

func (s *Store) Release(ctx context.Context, account, messageID string) error {
	if messageID == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, releaseSQL, account, messageID)
	return err
}

func (s *Store) Forget(ctx context.Context, account string, storedIDs ...string) error {
	if len(storedIDs) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, id := range storedIDs {
		if id == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, forgetSQL, account, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

const (
	pruneRecords = `DELETE FROM delivered WHERE at < ?`
	pruneClaims  = `DELETE FROM delivered WHERE at < ? AND stored_id = ''`
)

func (s *Store) Prune(ctx context.Context) (int64, error) {
	var total int64
	for _, q := range []struct {
		sql    string
		cutoff int64
	}{{pruneRecords, s.recordCutoff()}, {pruneClaims, s.leaseCutoff()}} {
		res, err := s.db.ExecContext(ctx, q.sql, q.cutoff)
		if err != nil {
			return total, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

func (s *Store) Close() error {
	s.once.Do(func() { close(s.stop) })
	return s.db.Close()
}

func (s *Store) recordCutoff() int64 { return s.now().Add(-s.ttl).Unix() }

func (s *Store) leaseCutoff() int64 { return s.now().Add(-s.lease).Unix() }

func (s *Store) prune(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			s.Prune(context.Background())
		case <-s.stop:
			return
		}
	}
}

func MessageID(literal []byte) string {
	hdr, _ := textproto.NewReader(bufio.NewReader(bytes.NewReader(literal))).ReadMIMEHeader()
	return strings.TrimSpace(hdr.Get("Message-Id"))
}
