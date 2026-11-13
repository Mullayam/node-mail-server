package kv

import (
	"bytes"
	"errors"

	"github.com/cockroachdb/pebble/v2"
)

type Pebble struct{ db *pebble.DB }

func OpenPebble(dir string) (*Pebble, error) {
	db, err := pebble.Open(dir, &pebble.Options{})
	if err != nil {
		return nil, err
	}
	return &Pebble{db: db}, nil
}

func (p *Pebble) Get(key []byte) ([]byte, error) {
	v, closer, err := p.db.Get(key)
	if errors.Is(err, pebble.ErrNotFound) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	defer closer.Close()
	return bytes.Clone(v), nil
}

func (p *Pebble) Set(key, value []byte) error { return p.db.Set(key, value, pebble.Sync) }

func (p *Pebble) Delete(key []byte) error { return p.db.Delete(key, pebble.Sync) }

func (p *Pebble) Scan(prefix []byte, fn func(key, value []byte) error) error {
	it, err := p.db.NewIter(&pebble.IterOptions{LowerBound: prefix, UpperBound: prefixEnd(prefix)})
	if err != nil {
		return err
	}
	for ok := it.First(); ok; ok = it.Next() {
		v, err := it.ValueAndErr()
		if err != nil {
			it.Close()
			return err
		}
		if err := fn(it.Key(), v); err != nil {
			it.Close()
			return err
		}
	}
	if err := it.Error(); err != nil {
		it.Close()
		return err
	}
	return it.Close()
}

func (p *Pebble) Batch(fn func(b Batch) error) error {
	b := p.db.NewBatch()
	defer b.Close()
	if err := fn(pebbleBatch{b}); err != nil {
		return err
	}
	return b.Commit(pebble.Sync)
}

func (p *Pebble) Close() error { return p.db.Close() }

type pebbleBatch struct{ b *pebble.Batch }

func (pb pebbleBatch) Set(key, value []byte) error { return pb.b.Set(key, value, nil) }
func (pb pebbleBatch) Delete(key []byte) error     { return pb.b.Delete(key, nil) }
