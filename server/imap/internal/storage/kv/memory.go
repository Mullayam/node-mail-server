package kv

import (
	"bytes"
	"sort"
	"strings"
	"sync"
)

// Memory is an in-memory Store for tests and quick experiments. Nothing
// survives a restart.
type Memory struct {
	mu sync.RWMutex
	m  map[string][]byte
}

// NewMemory returns an empty Memory store.
func NewMemory() *Memory { return &Memory{m: map[string][]byte{}} }

func (s *Memory) Get(key []byte) ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.m[string(key)]
	if !ok {
		return nil, ErrNotFound
	}
	return bytes.Clone(v), nil
}

func (s *Memory) Set(key, value []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[string(key)] = bytes.Clone(value)
	return nil
}

func (s *Memory) Delete(key []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, string(key))
	return nil
}

func (s *Memory) Scan(prefix []byte, fn func(key, value []byte) error) error {
	s.mu.RLock()
	var keys []string
	for k := range s.m {
		if strings.HasPrefix(k, string(prefix)) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	vals := make([][]byte, len(keys))
	for i, k := range keys {
		vals[i] = bytes.Clone(s.m[k])
	}
	s.mu.RUnlock()

	for i, k := range keys {
		if err := fn([]byte(k), vals[i]); err != nil {
			return err
		}
	}
	return nil
}

type memOp struct {
	key    string
	value  []byte
	delete bool
}

type memBatch struct{ ops []memOp }

func (b *memBatch) Set(key, value []byte) error {
	b.ops = append(b.ops, memOp{key: string(key), value: bytes.Clone(value)})
	return nil
}

func (b *memBatch) Delete(key []byte) error {
	b.ops = append(b.ops, memOp{key: string(key), delete: true})
	return nil
}

func (s *Memory) Batch(fn func(b Batch) error) error {
	b := &memBatch{}
	if err := fn(b); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, op := range b.ops {
		if op.delete {
			delete(s.m, op.key)
		} else {
			s.m[op.key] = op.value
		}
	}
	return nil
}

func (s *Memory) Close() error { return nil }
