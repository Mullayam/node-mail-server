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

type Store struct {
	db   *sql.DB
	ttl  time.Duration
	now  func() time.Time
	stop chan struct{}
	once sync.Once
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
	s := &Store{db: db, ttl: ttl, now: time.Now, stop: make(chan struct{})}
	if _, err := s.Prune(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	go s.prune(time.Hour)
	return s, nil
}

func (s *Store) Seen(ctx context.Context, account, messageID string) (string, bool, error) {
	if messageID == "" {
		return "", false, nil
	}
	var id string
	err := s.db.QueryRowContext(ctx,
		`SELECT stored_id FROM delivered WHERE account = ? AND message_id = ? AND at >= ?`,
		account, messageID, s.cutoff()).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

func (s *Store) Remember(ctx context.Context, account, messageID, storedID string) error {
	if messageID == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO delivered (account, message_id, stored_id, at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (account, message_id) DO UPDATE SET stored_id = excluded.stored_id, at = excluded.at`,
		account, messageID, storedID, s.now().Unix())
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
		if _, err := tx.ExecContext(ctx, `DELETE FROM delivered WHERE account = ? AND stored_id = ?`, account, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) Prune(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM delivered WHERE at < ?`, s.cutoff())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) Close() error {
	s.once.Do(func() { close(s.stop) })
	return s.db.Close()
}

func (s *Store) cutoff() int64 { return s.now().Add(-s.ttl).Unix() }

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
