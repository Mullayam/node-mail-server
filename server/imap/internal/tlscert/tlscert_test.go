package tlscert

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// selfSigned writes a certificate valid until notAfter and returns its paths.
func selfSigned(t *testing.T, dir string, notAfter time.Time) (string, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "imap.test"},
		DNSNames:     []string{"imap.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600)
	return certPath, keyPath
}

func TestLoadReloadAndConfig(t *testing.T) {
	dir := t.TempDir()
	first := time.Now().Add(24 * time.Hour).Truncate(time.Second)
	cert, key := selfSigned(t, dir, first)

	s, err := Load(cert, key)
	if err != nil {
		t.Fatal(err)
	}
	if !s.NotAfter().Equal(first) {
		t.Fatalf("NotAfter = %v, want %v", s.NotAfter(), first)
	}

	// A broken file is refused and the old certificate stays.
	bad := filepath.Join(dir, "bad.pem")
	os.WriteFile(bad, []byte("not a cert"), 0o600)
	if err := s.Reload(bad, key); err == nil {
		t.Fatal("reload of a broken file should fail")
	}
	if !s.NotAfter().Equal(first) {
		t.Fatal("old certificate was dropped")
	}

	// A renewed certificate is used by the same tls.Config from now on.
	cfg := s.Config()
	renewed := time.Now().Add(90 * 24 * time.Hour).Truncate(time.Second)
	cert2, key2 := selfSigned(t, t.TempDir(), renewed)
	if err := s.Reload(cert2, key2); err != nil {
		t.Fatal(err)
	}
	got, _ := cfg.GetCertificate(&tls.ClientHelloInfo{})
	if !got.Leaf.NotAfter.Equal(renewed) {
		t.Fatalf("config still serves the old certificate: %v", got.Leaf.NotAfter)
	}
	if cfg.MinVersion != tls.VersionTLS12 {
		t.Fatalf("MinVersion = %x", cfg.MinVersion)
	}
}
