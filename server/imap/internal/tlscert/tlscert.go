// Package tlscert holds the live TLS certificate for 993 and STARTTLS.
//
// The tls.Config it hands out asks for the certificate on every handshake,
// so a reload (for example after a Let's Encrypt renewal) takes effect for
// new connections without restarting the server.
package tlscert

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"sync/atomic"
	"time"
)

// Store keeps the current certificate.
type Store struct {
	cur atomic.Pointer[tls.Certificate]
}

// Load reads a PEM certificate chain and private key.
func Load(certFile, keyFile string) (*Store, error) {
	s := &Store{}
	if err := s.Reload(certFile, keyFile); err != nil {
		return nil, err
	}
	return s, nil
}

// Reload reads the files again. If they are invalid, the old certificate stays.
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

// NotAfter is when the current certificate expires.
func (s *Store) NotAfter() time.Time {
	if c := s.cur.Load(); c != nil && c.Leaf != nil {
		return c.Leaf.NotAfter
	}
	return time.Time{}
}

// Config returns a server tls.Config that always uses the current certificate.
func (s *Store) Config() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			return s.cur.Load(), nil
		},
	}
}
