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

func DefaultSocket() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(os.TempDir(), "imap-control.sock")
	}
	return "/run/imap/control.sock"
}

const MaxRequestBytes = 50 << 20

type Request struct {
	Command string            `json:"command"`
	Args    map[string]string `json:"args,omitempty"`
}

type Response struct {
	OK    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Data  json.RawMessage `json:"data,omitempty"`
}

type DispatchFunc func(ctx context.Context, command string, args map[string]string) (any, error)

func Serve(ctx context.Context, path string, dispatch DispatchFunc) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

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
	os.Chmod(path, 0o600)

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
	c.SetDeadline(time.Now().Add(60 * time.Second))

	var req Request
	if err := json.NewDecoder(io.LimitReader(c, MaxRequestBytes)).Decode(&req); err != nil {
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
