package factory

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

type idStore struct {
	path string
	mu   sync.Mutex
	ids  map[string]string
}

func openIDStore(path string) (*idStore, error) {
	s := &idStore{path: path, ids: map[string]string{}}
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, err
	}
	if err := json.Unmarshal(data, &s.ids); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *idStore) get(email string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.ids[email]
	return id, ok
}

func (s *idStore) set(email, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ids[email] = id
	data, err := json.MarshalIndent(s.ids, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
