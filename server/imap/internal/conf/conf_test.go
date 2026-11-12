package conf

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestExampleParses(t *testing.T) {
	c, err := Load("../../conf/imap.example.xml")
	if err != nil {
		t.Fatal(err)
	}
	if c.Listen != "0.0.0.0:143" || c.DataDir != "/data/gluon" {
		t.Errorf("settings = %q %q", c.Listen, c.DataDir)
	}
	if c.Directory.Name != "file" || c.Directory.Options["source"] != "/etc/imap/users.xml" {
		t.Errorf("directory = %+v", c.Directory)
	}
	if c.Storage.Name != "pebble" || c.Storage.Options["path"] != "/data/mail" {
		t.Errorf("storage = %+v", c.Storage)
	}
	if c.Quota.StorageBytes != 1<<30 || c.Quota.Messages != 50000 {
		t.Errorf("quota = %+v", c.Quota)
	}
}

func TestParseReportsEveryProblem(t *testing.T) {
	_, err := Parse([]byte(`<imap><settings><listen address="nope"/></settings><quota storage="lots"/></imap>`))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"listen address", "directory kind", "storage engine", "quota storage"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q:\n%v", want, err)
		}
	}
}

func TestTLSSettings(t *testing.T) {
	base := `<directory kind="file" source="u.xml"/><storage engine="memory"/></imap>`
	c, err := Parse([]byte(`<imap><settings><tls cert="/c.pem" key="/k.pem"/></settings>` + base))
	if err != nil {
		t.Fatal(err)
	}
	if !c.TLS.Enabled() || c.TLS.Listen != DefaultTLSListen {
		t.Fatalf("tls = %+v", c.TLS)
	}
	if c, _ := Parse([]byte(`<imap>` + base)); c.TLS.Enabled() {
		t.Fatal("TLS should be off without <tls>")
	}
	if _, err := Parse([]byte(`<imap><settings><tls cert="/c.pem"/></settings>` + base)); err == nil || !strings.Contains(err.Error(), "both cert and key") {
		t.Fatalf("cert without key: %v", err)
	}
}

func TestReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "imap.xml")
	base := `<imap><directory kind="file" source="u.xml"/><storage engine="dir" path="/m"/><quota storage="1GB"/></imap>`
	write(t, path, base)
	h, err := NewHolder(path)
	if err != nil {
		t.Fatal(err)
	}

	// Invalid file: refused, generation 1 stays live.
	write(t, path, `<imap><broken`)
	if _, err := h.Reload(); err == nil {
		t.Fatal("reload of an invalid file should fail")
	}
	if g := h.Current().Generation; g != 1 {
		t.Fatalf("generation = %d, want 1", g)
	}

	// Quota change applies; listen change needs a restart.
	write(t, path, `<imap><settings><listen address="0.0.0.0:1143"/></settings>`+
		`<directory kind="file" source="u.xml"/><storage engine="dir" path="/m"/><quota storage="2GB"/></imap>`)
	rep, err := h.Reload()
	if err != nil {
		t.Fatal(err)
	}
	if rep.Generation != 2 || !rep.QuotaChanged || len(rep.RestartRequired) != 1 {
		t.Fatalf("report = %+v", rep)
	}
	if h.Current().Quota.StorageBytes != 2<<30 {
		t.Errorf("quota not applied: %+v", h.Current().Quota)
	}
}
