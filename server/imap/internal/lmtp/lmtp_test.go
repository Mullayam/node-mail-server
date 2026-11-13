package lmtp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

var errFull = errors.New("full")

type fakeBackend struct {
	mu   sync.Mutex
	got  map[string]string
	full map[string]bool
}

func (f *fakeBackend) Accepts(a string) bool { return strings.HasSuffix(a, "@example.org") }

func (f *fakeBackend) Deliver(_ context.Context, a, mbox string, msg []byte) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.full[a] {
		return "", errFull
	}
	f.got[a] = mbox + "|" + string(msg)
	return "id-" + a, nil
}

func start(t *testing.T, allowed func(netip.Addr) bool, max int64) (*fakeBackend, string) {
	t.Helper()
	b := &fakeBackend{got: map[string]string{}, full: map[string]bool{"carol@example.org": true}}
	srv := &Server{
		Backend: b, Hostname: "imap.test", Allowed: allowed, MaxSize: max,
		Classify: func(err error) Reply {
			if errors.Is(err, errFull) {
				return Reply{552, "5.2.2", "mailbox full"}
			}
			return Reply{451, "4.3.0", "try later"}
		},
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve(ln)
	t.Cleanup(srv.Shutdown)
	return b, ln.Addr().String()
}

type client struct {
	t *testing.T
	c net.Conn
	r *bufio.Reader
}

func dial(t *testing.T, addr string) *client {
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	t.Cleanup(func() { c.Close() })
	return &client{t, c, bufio.NewReader(c)}
}

// line reads one reply line.
func (c *client) line() string {
	l, err := c.r.ReadString('\n')
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return strings.TrimRight(l, "\r\n")
}

// cmd sends a command and returns the final reply line (after any 250- lines).
func (c *client) cmd(s string) string {
	fmt.Fprintf(c.c, "%s\r\n", s)
	for {
		l := c.line()
		if len(l) < 4 || l[3] != '-' {
			return l
		}
	}
}

func allowAll(netip.Addr) bool { return true }

func TestDeliveryPerRecipient(t *testing.T) {
	b, addr := start(t, allowAll, 1<<20)
	c := dial(t, addr)
	if g := c.line(); !strings.HasPrefix(g, "220 ") {
		t.Fatalf("greeting %q", g)
	}
	if r := c.cmd("EHLO x"); !strings.HasPrefix(r, "500") {
		t.Errorf("EHLO should be refused: %q", r)
	}
	if r := c.cmd("LHLO mx.test"); !strings.HasPrefix(r, "250 ") {
		t.Fatalf("LHLO: %q", r)
	}
	if r := c.cmd("MAIL FROM:<>"); !strings.HasPrefix(r, "250") {
		t.Fatalf("null sender: %q", r)
	}
	// A slice, not a map: LMTP answers after DATA in RCPT order.
	for _, tc := range []struct{ rcpt, want string }{
		{"alice@example.org", "250"}, {"carol@example.org", "250"}, {"nobody@other.com", "550"},
	} {
		if r := c.cmd("RCPT TO:<" + tc.rcpt + ">"); !strings.HasPrefix(r, tc.want) {
			t.Errorf("RCPT %s: %q, want %s", tc.rcpt, r, tc.want)
		}
	}
	// Dot-stuffed line and bare LF must come out as ".x" and CRLF.
	fmt.Fprintf(c.c, "DATA\r\n")
	if r := c.line(); !strings.HasPrefix(r, "354") {
		t.Fatalf("DATA: %q", r)
	}
	fmt.Fprintf(c.c, "Subject: hi\r\n\r\n..x\nbody\r\n.\r\n")

	// One reply per accepted recipient, in order: alice delivered, carol full.
	if r := c.line(); !strings.HasPrefix(r, "250 2.0.0 <alice@example.org>") {
		t.Errorf("alice: %q", r)
	}
	if r := c.line(); !strings.HasPrefix(r, "552 5.2.2 <carol@example.org>") {
		t.Errorf("carol: %q", r)
	}
	// LMTP leaves the mailbox empty so the backend files it (INBOX or Junk).
	if got := b.got["alice@example.org"]; got != "|Subject: hi\r\n\r\n.x\r\nbody\r\n" {
		t.Errorf("stored %q", got)
	}
	if r := c.cmd("QUIT"); !strings.HasPrefix(r, "221") {
		t.Errorf("QUIT: %q", r)
	}
}

func TestTooBigAndOrder(t *testing.T) {
	_, addr := start(t, allowAll, 10)
	c := dial(t, addr)
	c.line()
	if r := c.cmd("RCPT TO:<a@example.org>"); !strings.HasPrefix(r, "503") {
		t.Errorf("RCPT before MAIL: %q", r)
	}
	c.cmd("LHLO x")
	c.cmd("MAIL FROM:<s@x.com>")
	c.cmd("RCPT TO:<a@example.org>")
	fmt.Fprintf(c.c, "DATA\r\n")
	c.line()
	fmt.Fprintf(c.c, "%s\r\n.\r\n", strings.Repeat("x", 100))
	if r := c.line(); !strings.HasPrefix(r, "552 5.3.4") {
		t.Errorf("too big: %q", r)
	}
	if r := c.cmd("NOOP"); !strings.HasPrefix(r, "250") {
		t.Errorf("session out of step after a too-big message: %q", r)
	}
}

func TestUntrustedClientRefused(t *testing.T) {
	_, addr := start(t, func(netip.Addr) bool { return false }, 1<<20)
	c := dial(t, addr)
	if g := c.line(); !strings.HasPrefix(g, "554 5.7.1") {
		t.Errorf("untrusted greeting %q", g)
	}
}
