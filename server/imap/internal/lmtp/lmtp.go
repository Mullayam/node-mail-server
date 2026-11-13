// Package lmtp is the delivery door into IMAP storage (RFC 2033).
//
// The SMTP server (the Node app) accepts mail from the internet, checks it,
// then hands each message to this listener. LMTP answers once per recipient
// after DATA, so the sender learns exactly which mailboxes got the message.
// The listener is unauthenticated, so it only talks to trusted networks and
// must never be published to the internet.
package lmtp

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// Backend stores messages. core/factory implements it.
type Backend interface {
	// Accepts reports whether address has a mailbox (an IMAP user).
	Accepts(address string) bool
	// Deliver stores literal for the user. An empty mailbox lets the backend
	// file it (INBOX, or Junk when the message is marked as spam).
	Deliver(ctx context.Context, address, mailbox string, literal []byte) (string, error)
}

// Reply is one SMTP/LMTP status line.
type Reply struct {
	Code   int
	Status string // enhanced status code, for example "2.0.0"
	Text   string
}

func (r Reply) String() string { return fmt.Sprintf("%d %s %s", r.Code, r.Status, r.Text) }

// Server accepts LMTP connections.
type Server struct {
	Backend  Backend
	Hostname string
	// Allowed is asked for every new connection, so reloading the trusted
	// list in imap.xml applies without a restart.
	Allowed func(netip.Addr) bool
	// MaxSize is the largest message accepted, in bytes.
	MaxSize int64
	// Classify turns a Deliver error into a reply. Unknown errors become a
	// temporary failure, so the sender retries.
	Classify func(error) Reply

	mu    sync.Mutex
	ln    net.Listener
	conns map[net.Conn]struct{}
	wg    sync.WaitGroup
}

// Serve accepts connections until Shutdown.
func (s *Server) Serve(ln net.Listener) error {
	s.mu.Lock()
	s.ln, s.conns = ln, map[net.Conn]struct{}{}
	s.mu.Unlock()
	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		s.mu.Lock()
		s.conns[c] = struct{}{}
		s.mu.Unlock()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			defer func() {
				s.mu.Lock()
				delete(s.conns, c)
				s.mu.Unlock()
				c.Close()
			}()
			s.session(c)
		}()
	}
}

// Shutdown stops accepting, closes open sessions and waits for them.
func (s *Server) Shutdown() {
	s.mu.Lock()
	if s.ln != nil {
		s.ln.Close()
	}
	for c := range s.conns {
		c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

const maxLine = 4096

func (s *Server) session(c net.Conn) {
	r := bufio.NewReaderSize(c, maxLine)
	w := bufio.NewWriter(c)
	reply := func(format string, args ...any) {
		fmt.Fprintf(w, format+"\r\n", args...)
		w.Flush()
	}

	if ap, err := netip.ParseAddrPort(c.RemoteAddr().String()); err != nil || s.Allowed == nil || !s.Allowed(ap.Addr()) {
		log.Printf("lmtp: refused connection from %s: not in <lmtp trusted>", c.RemoteAddr())
		reply("554 5.7.1 %s: you are not allowed to deliver here", s.Hostname)
		return
	}
	reply("220 %s LMTP ready", s.Hostname)

	var (
		greeted bool
		inMail  bool
		from    string
		rcpts   []string
	)
	reset := func() { inMail, from, rcpts = false, "", nil }

	for {
		c.SetReadDeadline(time.Now().Add(5 * time.Minute))
		line, err := readLine(r)
		if err != nil {
			return
		}
		verb, arg, _ := strings.Cut(line, " ")
		switch strings.ToUpper(verb) {
		case "LHLO":
			greeted = true
			reset()
			reply("250-%s", s.Hostname)
			reply("250-PIPELINING")
			reply("250-ENHANCEDSTATUSCODES")
			reply("250-8BITMIME")
			reply("250 SIZE %d", s.MaxSize)
		case "HELO", "EHLO":
			reply("500 5.5.1 this is an LMTP server: use LHLO")
		case "MAIL":
			addr, ok := pathArg(arg, "FROM:")
			switch {
			case !greeted:
				reply("503 5.5.1 send LHLO first")
			case inMail:
				reply("503 5.5.1 MAIL already given")
			case !ok:
				reply("501 5.5.4 syntax: MAIL FROM:<address>")
			default:
				inMail, from, rcpts = true, addr, nil
				reply("250 2.1.0 sender <%s> ok", from)
			}
		case "RCPT":
			addr, ok := pathArg(arg, "TO:")
			switch {
			case !inMail:
				reply("503 5.5.1 send MAIL first")
			case !ok || addr == "":
				reply("501 5.5.4 syntax: RCPT TO:<address>")
			case !s.Backend.Accepts(addr):
				reply("550 5.1.1 <%s>: no such mailbox", addr)
			default:
				rcpts = append(rcpts, addr)
				reply("250 2.1.5 <%s> ok", addr)
			}
		case "DATA":
			if len(rcpts) == 0 {
				reply("503 5.5.1 no valid recipients")
				continue
			}
			reply("354 send the message, end with <CRLF>.<CRLF>")
			c.SetReadDeadline(time.Now().Add(10 * time.Minute))
			msg, tooBig, err := readData(r, s.MaxSize)
			if err != nil {
				return
			}
			// LMTP: one reply per accepted recipient, in RCPT order.
			for _, rcpt := range rcpts {
				if tooBig {
					reply("552 5.3.4 <%s>: message larger than %d bytes", rcpt, s.MaxSize)
					continue
				}
				reply("%s", s.deliver(rcpt, msg))
			}
			reset()
		case "RSET":
			reset()
			reply("250 2.0.0 ok")
		case "NOOP":
			reply("250 2.0.0 ok")
		case "VRFY":
			reply("252 2.5.0 cannot verify, try RCPT")
		case "QUIT":
			reply("221 2.0.0 bye")
			return
		default:
			reply("500 5.5.2 unknown command")
		}
	}
}

func (s *Server) deliver(rcpt string, msg []byte) string {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	id, err := s.Backend.Deliver(ctx, rcpt, "", msg)
	if err == nil {
		return fmt.Sprintf("250 2.0.0 <%s> delivered as %s", rcpt, id)
	}
	rep := Reply{Code: 451, Status: "4.3.0", Text: "temporary failure, try again later"}
	if s.Classify != nil {
		rep = s.Classify(err)
	}
	log.Printf("lmtp: delivery to %s failed: %v", rcpt, err)
	return fmt.Sprintf("%d %s <%s>: %s", rep.Code, rep.Status, rcpt, rep.Text)
}

// readLine reads one command line without its CRLF.
func readLine(r *bufio.Reader) (string, error) {
	line, isPrefix, err := r.ReadLine()
	if err != nil {
		return "", err
	}
	if isPrefix {
		return "", errors.New("command line too long")
	}
	return string(line), nil
}

// pathArg reads "FROM:<a@b>" or "TO:<a@b> PARAMS" and returns the address.
// "<>" (the null sender) gives an empty address.
func pathArg(arg, prefix string) (string, bool) {
	if len(arg) < len(prefix) || !strings.EqualFold(arg[:len(prefix)], prefix) {
		return "", false
	}
	rest := strings.TrimSpace(arg[len(prefix):])
	if !strings.HasPrefix(rest, "<") {
		return "", false
	}
	end := strings.IndexByte(rest, '>')
	if end < 0 {
		return "", false
	}
	return strings.TrimSpace(rest[1:end]), true
}

// readData reads the message up to the "." line, removes dot-stuffing and
// makes every line end in CRLF. Past max bytes it keeps reading (so the
// session stays in step) but reports tooBig.
func readData(r *bufio.Reader, max int64) (msg []byte, tooBig bool, err error) {
	var buf bytes.Buffer
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			if err == io.EOF {
				err = io.ErrUnexpectedEOF
			}
			return nil, false, err
		}
		body := bytes.TrimRight(line, "\r\n")
		if bytes.Equal(body, []byte(".")) {
			return buf.Bytes(), tooBig, nil
		}
		if bytes.HasPrefix(body, []byte("..")) {
			body = body[1:]
		}
		if int64(buf.Len()+len(body)+2) > max {
			tooBig = true
			continue
		}
		buf.Write(body)
		buf.WriteString("\r\n")
	}
}
