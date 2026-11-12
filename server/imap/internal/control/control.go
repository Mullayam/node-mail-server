// Package control carries router commands between imapctl and the running
// server over a Unix socket inside the container.
//
// The client sends one JSON line, {"command":"user.add","args":{...}}, and
// reads one JSON line back. The socket is not a network port, so only someone
// who can run "docker exec" in the container can use it.
package control

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// DefaultSocket is the socket path when IMAP_CONTROL_SOCKET is not set.
func DefaultSocket() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.TempDir(), "imap-control.sock")
	}
	return "/run/imap/control.sock"
}

// Request is what imapctl sends.
type Request struct {
	Command string            `json:"command"`
	Args    map[string]string `json:"args,omitempty"`
}

// Response is what the server answers.
type Response struct {
	OK    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

// DispatchFunc runs a command. router.Router.Dispatch fits it.
type DispatchFunc func(ctx context.Context, command string, args map[string]string) (any, error)

// Serve listens on the socket until ctx is cancelled.
func Serve(ctx context.Context, path string, dispatch DispatchFunc) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	// A socket file left by a crash blocks listening. If nothing answers on
	// it, it is stale and safe to remove.
	if _, err := os.Stat(path); err == nil {
		if c, err := net.DialTimeout("unix", path, time.Second); err == nil {
			c.Close()
			return fmt.Errorf("control socket %s is in use: is another server running?", path)
		}
		os.Remove(path)
	}

	ln, err := net.Listen("unix", path)
	if err != nil {
		return err
	}
	os.Chmod(path, 0o600) // only the server's own user may use it

	go func() {
		<-ctx.Done()
		ln.Close()
		os.Remove(path)
	}()

	for {
		c, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go handle(ctx, c, dispatch)
	}
}

func handle(ctx context.Context, c net.Conn, dispatch DispatchFunc) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(30 * time.Second))

	var req Request
	if err := json.NewDecoder(io.LimitReader(c, 64<<10)).Decode(&req); err != nil {
		send(c, Response{Error: "bad request: " + err.Error()})
		return
	}
	data, err := dispatch(ctx, req.Command, req.Args)
	if err != nil {
		send(c, Response{Error: err.Error()})
		return
	}
	raw, err := json.Marshal(data)
	if err != nil {
		send(c, Response{Error: err.Error()})
		return
	}
	send(c, Response{OK: true, Data: raw})
}

func send(c net.Conn, r Response) { json.NewEncoder(c).Encode(r) }

// Do sends one command to the running server and returns its answer.
func Do(path string, req Request, timeout time.Duration) (*Response, error) {
	c, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the IMAP server on %s (is it running?): %w", path, err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(timeout))

	if err := json.NewEncoder(c).Encode(req); err != nil {
		return nil, err
	}
	var resp Response
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&resp); err != nil {
		return nil, fmt.Errorf("no answer from the IMAP server: %w", err)
	}
	return &resp, nil
}
