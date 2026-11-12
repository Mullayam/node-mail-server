// Package router maps admin commands (reload, user.add, quota.set, ...) to
// handlers. The control socket and imapctl only move commands in and out;
// everything they can do is listed here, so adding a command is one Handle call.
package router

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// ErrUnknownCommand is returned for a command nobody registered.
var ErrUnknownCommand = errors.New("unknown command")

// Args are the command's named arguments, for example {"address": "a@b.c"}.
type Args map[string]string

// Require returns the named argument or an error if it is missing.
func (a Args) Require(name string) (string, error) {
	v := strings.TrimSpace(a[name])
	if v == "" {
		return "", fmt.Errorf("missing argument %q", name)
	}
	return v, nil
}

// HandlerFunc runs one command. The result is sent back as JSON.
type HandlerFunc func(ctx context.Context, args Args) (any, error)

// Route describes a registered command for "imapctl routes".
type Route struct {
	Command string `json:"command"`
	Usage   string `json:"usage"`
	Help    string `json:"help"`
}

type entry struct {
	Route
	h HandlerFunc
}

// Router holds the commands.
type Router struct {
	mu      sync.RWMutex
	entries map[string]entry
	aliases map[string]string
}

// New returns an empty Router.
func New() *Router {
	return &Router{entries: map[string]entry{}, aliases: map[string]string{}}
}

// Handle registers a command.
func (r *Router) Handle(command, usage, help string, h HandlerFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[command] = entry{Route: Route{Command: command, Usage: usage, Help: help}, h: h}
}

// Alias makes another name run an existing command.
func (r *Router) Alias(alias, command string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.aliases[alias] = command
}

// Dispatch runs a command.
func (r *Router) Dispatch(ctx context.Context, command string, args Args) (any, error) {
	r.mu.RLock()
	if target, ok := r.aliases[command]; ok {
		command = target
	}
	e, ok := r.entries[command]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w %q (run: imapctl routes)", ErrUnknownCommand, command)
	}
	if args == nil {
		args = Args{}
	}
	return e.h(ctx, args)
}

// Routes lists the registered commands, sorted.
func (r *Router) Routes() []Route {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Route, 0, len(r.entries))
	for _, e := range r.entries {
		out = append(out, e.Route)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Command < out[j].Command })
	return out
}
