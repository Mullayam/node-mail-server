package storage

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"imap/internal/quota"
	"imap/internal/storage/kv"
)

func init() {
	Register("pebble", func(opts map[string]string) (Engine, error) {
		if opts["path"] == "" {
			return nil, errors.New(`pebble storage: <storage engine="pebble"> needs a path="..." attribute`)
		}
		db, err := kv.OpenPebble(opts["path"])
		if err != nil {
			return nil, fmt.Errorf("pebble storage: %w", err)
		}
		return NewKVEngine(db), nil
	})
}

type KVEngine struct {
	db kv.Store
	mu sync.Mutex
}

func NewKVEngine(db kv.Store) *KVEngine { return &KVEngine{db: db} }

func kMailbox(a, id string) []byte   { return kv.Key("acct", a, "mbox", id) }
func kMessage(a, id string) []byte   { return kv.Key("acct", a, "msg", id) }
func kBody(a, id string) []byte      { return kv.Key("acct", a, "body", id) }
func kIn(a, mbox, msg string) []byte { return kv.Key("acct", a, "in", mbox, msg) }
func kMsgIn(a, msg, mbox string) []byte {
	return kv.Key("acct", a, "msgin", msg, mbox)
}
func kUsage(a string) []byte { return kv.Key("acct", a, "usage") }

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (e *KVEngine) ListMailboxes(_ context.Context, a string) ([]Mailbox, error) {
	var out []Mailbox
	err := e.db.Scan(kv.Prefix("acct", a, "mbox"), func(_, v []byte) error {
		var m Mailbox
		if err := json.Unmarshal(v, &m); err != nil {
			return err
		}
		out = append(out, m)
		return nil
	})
	return out, err
}

func (e *KVEngine) ListMessages(_ context.Context, a, mailboxID string) ([]Message, error) {
	if err := e.mailboxExists(a, mailboxID); err != nil {
		return nil, err
	}
	keys, err := kv.Keys(e.db, kv.Prefix("acct", a, "in", mailboxID))
	if err != nil {
		return nil, err
	}
	out := make([]Message, 0, len(keys))
	for _, k := range keys {
		m, err := kv.GetJSON[Message](e.db, kMessage(a, kv.LastPart(k)))
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

func (e *KVEngine) GetMessage(_ context.Context, a, messageID string) ([]byte, error) {
	body, err := e.db.Get(kBody(a, messageID))
	if errors.Is(err, kv.ErrNotFound) {
		return nil, fmt.Errorf("%w: %s", ErrMessageNotFound, messageID)
	}
	return body, err
}

func (e *KVEngine) Usage(_ context.Context, a string) (quota.Usage, error) {
	u, err := kv.GetJSON[quota.Usage](e.db, kUsage(a))
	if errors.Is(err, kv.ErrNotFound) {
		return quota.Usage{}, nil
	}
	return u, err
}

func (e *KVEngine) CreateMailbox(_ context.Context, a string, name []string) (string, error) {
	id := newID()
	return id, kv.SetJSON(e.db, kMailbox(a, id), Mailbox{ID: id, Name: name})
}

func (e *KVEngine) RenameMailbox(_ context.Context, a, id string, newName []string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	m, err := e.mailbox(a, id)
	if err != nil {
		return err
	}
	m.Name = newName
	return kv.SetJSON(e.db, kMailbox(a, id), m)
}

func (e *KVEngine) DeleteMailbox(_ context.Context, a, id string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.mailboxExists(a, id); err != nil {
		return err
	}
	keys, err := kv.Keys(e.db, kv.Prefix("acct", a, "in", id))
	if err != nil {
		return err
	}
	msgs := make([]string, len(keys))
	for i, k := range keys {
		msgs[i] = kv.LastPart(k)
	}
	return e.db.Batch(func(b kv.Batch) error {
		if err := b.Delete(kMailbox(a, id)); err != nil {
			return err
		}
		return e.leave(b, a, msgs, id)
	})
}

func (e *KVEngine) CreateMessage(_ context.Context, a, mailboxID string, literal []byte, flags []string, date time.Time) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.mailboxExists(a, mailboxID); err != nil {
		return "", err
	}
	u, err := e.Usage(context.Background(), a)
	if err != nil {
		return "", err
	}
	id := newID()
	msg := Message{ID: id, Size: int64(len(literal)), Flags: normalizeFlags(flags), Date: date}
	u.StorageBytes += msg.Size
	u.Messages++
	return id, e.db.Batch(func(b kv.Batch) error {
		return errors.Join(
			kv.SetJSON(b, kMessage(a, id), msg),
			b.Set(kBody(a, id), literal),
			b.Set(kIn(a, mailboxID, id), nil),
			b.Set(kMsgIn(a, id, mailboxID), nil),
			kv.SetJSON(b, kUsage(a), u),
		)
	})
}

func (e *KVEngine) AddToMailbox(_ context.Context, a string, ids []string, mailboxID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.messagesAndMailboxExist(a, ids, mailboxID); err != nil {
		return err
	}
	return e.db.Batch(func(b kv.Batch) error { return e.join(b, a, ids, mailboxID) })
}

func (e *KVEngine) RemoveFromMailbox(_ context.Context, a string, ids []string, mailboxID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.mailboxExists(a, mailboxID); err != nil {
		return err
	}
	return e.db.Batch(func(b kv.Batch) error { return e.leave(b, a, ids, mailboxID) })
}

func (e *KVEngine) MoveMessages(_ context.Context, a string, ids []string, fromID, toID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if fromID == toID {
		return nil
	}
	if err := errors.Join(e.mailboxExists(a, fromID), e.messagesAndMailboxExist(a, ids, toID)); err != nil {
		return err
	}
	return e.db.Batch(func(b kv.Batch) error {
		if err := e.join(b, a, ids, toID); err != nil {
			return err
		}
		for _, id := range ids {
			if err := errors.Join(b.Delete(kIn(a, fromID, id)), b.Delete(kMsgIn(a, id, fromID))); err != nil {
				return err
			}
		}
		return nil
	})
}

func (e *KVEngine) SetFlag(_ context.Context, a string, ids []string, flag string, on bool) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	msgs := make([]Message, len(ids))
	for i, id := range ids {
		m, err := e.message(a, id)
		if err != nil {
			return err
		}
		m.Flags = slices.DeleteFunc(m.Flags, func(f string) bool { return strings.EqualFold(f, flag) })
		if on {
			m.Flags = append(m.Flags, flag)
		}
		msgs[i] = m
	}
	return e.db.Batch(func(b kv.Batch) error {
		for _, m := range msgs {
			if err := kv.SetJSON(b, kMessage(a, m.ID), m); err != nil {
				return err
			}
		}
		return nil
	})
}

func (e *KVEngine) Close() error { return e.db.Close() }

func (e *KVEngine) mailbox(a, id string) (Mailbox, error) {
	m, err := kv.GetJSON[Mailbox](e.db, kMailbox(a, id))
	if errors.Is(err, kv.ErrNotFound) {
		return m, fmt.Errorf("%w: %s", ErrMailboxNotFound, id)
	}
	return m, err
}

func (e *KVEngine) mailboxExists(a, id string) error {
	_, err := e.mailbox(a, id)
	return err
}

func (e *KVEngine) message(a, id string) (Message, error) {
	m, err := kv.GetJSON[Message](e.db, kMessage(a, id))
	if errors.Is(err, kv.ErrNotFound) {
		return m, fmt.Errorf("%w: %s", ErrMessageNotFound, id)
	}
	return m, err
}

func (e *KVEngine) messagesAndMailboxExist(a string, ids []string, mailboxID string) error {
	if err := e.mailboxExists(a, mailboxID); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := e.message(a, id); err != nil {
			return err
		}
	}
	return nil
}

func (e *KVEngine) join(b kv.Batch, a string, ids []string, mailboxID string) error {
	for _, id := range ids {
		if err := errors.Join(b.Set(kIn(a, mailboxID, id), nil), b.Set(kMsgIn(a, id, mailboxID), nil)); err != nil {
			return err
		}
	}
	return nil
}

func (e *KVEngine) leave(b kv.Batch, a string, ids []string, mailboxID string) error {
	u, err := e.Usage(context.Background(), a)
	if err != nil {
		return err
	}
	changed := false
	for _, id := range ids {
		if err := errors.Join(b.Delete(kIn(a, mailboxID, id)), b.Delete(kMsgIn(a, id, mailboxID))); err != nil {
			return err
		}
		others, err := kv.Keys(e.db, kv.Prefix("acct", a, "msgin", id))
		if err != nil {
			return err
		}
		remaining := slices.DeleteFunc(others, func(k []byte) bool { return kv.LastPart(k) == mailboxID })
		if len(remaining) > 0 {
			continue
		}
		m, err := e.message(a, id)
		if errors.Is(err, ErrMessageNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if err := errors.Join(b.Delete(kMessage(a, id)), b.Delete(kBody(a, id))); err != nil {
			return err
		}
		u.StorageBytes = max(0, u.StorageBytes-m.Size)
		u.Messages = max(0, u.Messages-1)
		changed = true
	}
	if changed {
		return kv.SetJSON(b, kUsage(a), u)
	}
	return nil
}

func normalizeFlags(flags []string) []string {
	out := make([]string, 0, len(flags))
	for _, f := range flags {
		if !slices.ContainsFunc(out, func(g string) bool { return strings.EqualFold(f, g) }) {
			out = append(out, f)
		}
	}
	return out
}
