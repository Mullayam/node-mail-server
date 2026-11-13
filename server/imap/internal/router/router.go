package router

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

var ErrUnknownCommand = errors.New("unknown command")

type Args map[string]string

func (a Args) Require(name string) (string, error) {
	v := strings.TrimSpace(a[name])
	if v == "" {
		return "", fmt.Errorf("missing argument %q", name)
	}
	return v, nil
}

type HandlerFunc func(ctx context.Context, args Args) (any, error)

type Route struct {
	Command string `json:"command"`
	Usage   string `json:"usage"`
	Help    string `json:"help"`
}

type entry struct {
	Route
	h HandlerFunc
}

type Router struct {
	mu      sync.RWMutex
	entries map[string]entry
	aliases map[string]string
}

func New() *Router {
	return &Router{entries: map[string]entry{}, aliases: map[string]string{}}
}

func (r *Router) Handle(command, usage, help string, h HandlerFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries[command] = entry{Route: Route{Command: command, Usage: usage, Help: help}, h: h}
}

func (r *Router) Alias(alias, command string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.aliases[alias] = command
}

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
