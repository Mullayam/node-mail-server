package tlscert

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"sync/atomic"
	"time"
)

type Store struct {
	cur atomic.Pointer[tls.Certificate]
}

func Load(certFile, keyFile string) (*Store, error) {
	s := &Store{}
	if err := s.Reload(certFile, keyFile); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Reload(certFile, keyFile string) error {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return fmt.Errorf("tls: %w", err)
	}
	if cert.Leaf == nil && len(cert.Certificate) > 0 {
		if leaf, err := x509.ParseCertificate(cert.Certificate[0]); err == nil {
			cert.Leaf = leaf
		}
	}
	s.cur.Store(&cert)
	return nil
}

func (s *Store) NotAfter() time.Time {
	if c := s.cur.Load(); c != nil && c.Leaf != nil {
		return c.Leaf.NotAfter
	}
	return time.Time{}
}

func (s *Store) Config() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			return s.cur.Load(), nil
		},
	}
}
