package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/smtp"
	"net/textproto"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	statusDelivered     = "2.0.0"
	statusTemporary     = "4.0.0"
	statusPermanent     = "5.0.0"
	statusNoMX          = "5.1.2"
	statusBadAddress    = "5.1.3"
	statusNullMX        = "5.1.10"
	statusMXUnreachable = "4.4.1"
	statusCancelled     = "4.4.2"
	statusDNSFailure    = "4.4.3"
)

const (
	msgInvalidRecipient = "Invalid recipient address"
	msgNoMX             = "Domain %s has no MX records"
	msgNullMX           = "Domain %s does not accept mail"
	msgMXLookupFailed   = "MX lookup failed for %s: %v"
	msgMXUnreachable    = "No reachable MX server found for domain %s: %v"
	msgCancelled        = "Delivery cancelled: %v"
	msgAccepted         = "250 Message accepted"
	msgUnauthorized     = "unauthorized"
	msgInvalidJSON      = "invalid JSON body: %v"
	msgInvalidBase64    = "raw must be base64: %v"
	msgNoRecipients     = "at least one recipient is required"
	msgInvalidAddress   = "invalid address: %q"
	msgTooLarge         = "request body is larger than %d bytes"
)

var (
	enhancedStatus = regexp.MustCompile(`\b[245]\.\d{1,3}\.\d{1,3}\b`)
	errStartTLS    = errors.New("STARTTLS failed")
)

type config struct {
	listen         string
	token          string
	ehlo           string
	smtpPort       string
	connectTimeout time.Duration
	sessionTimeout time.Duration
	maxBodyBytes   int64
	maxConcurrency int
	routes         map[string]string
}

type deliverRequest struct {
	From string   `json:"from"`
	To   []string `json:"to"`
	Raw  string   `json:"raw"`
}

type result struct {
	Recipient string `json:"recipient"`
	Success   bool   `json:"success"`
	Temporary bool   `json:"temporary"`
	Status    string `json:"status"`
	Response  string `json:"response"`
	RemoteMTA string `json:"remoteMta,omitempty"`
}

type service struct {
	cfg       config
	limiter   chan struct{}
	tokenHash [32]byte
}

func main() {
	cfg := loadConfig()
	svc := &service{cfg: cfg, limiter: make(chan struct{}, cfg.maxConcurrency), tokenHash: sha256.Sum256([]byte(cfg.token))}
	if cfg.token == "" {
		log.Printf("GO_MTA_TOKEN is not set: any client that can reach %s can send mail", cfg.listen)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /v1/deliver", svc.handleDeliver)

	server := &http.Server{
		Addr:              cfg.listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("Go MTA listening on %s (EHLO %s)", cfg.listen, cfg.ehlo)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("Go MTA failed to listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Printf("Shutting down, waiting up to %s for deliveries in progress", cfg.sessionTimeout)
	ctx, cancel := context.WithTimeout(context.Background(), cfg.sessionTimeout)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Shutdown error: %v", err)
	}
}

func loadConfig() config {
	ehlo := os.Getenv("GO_MTA_EHLO")
	if ehlo == "" {
		ehlo, _ = os.Hostname()
	}
	return config{
		listen:         envString("GO_MTA_LISTEN", "127.0.0.1:2580"),
		token:          os.Getenv("GO_MTA_TOKEN"),
		ehlo:           ehlo,
		smtpPort:       envString("GO_MTA_SMTP_PORT", "25"),
		connectTimeout: time.Duration(envInt("GO_MTA_CONNECT_TIMEOUT_SEC", 30)) * time.Second,
		sessionTimeout: time.Duration(envInt("GO_MTA_SESSION_TIMEOUT_SEC", 300)) * time.Second,
		maxBodyBytes:   int64(envInt("GO_MTA_MAX_BODY_MB", 20)) << 20,
		maxConcurrency: envInt("GO_MTA_MAX_CONCURRENCY", 50),
		routes:         parseRoutes(os.Getenv("GO_MTA_ROUTES")),
	}
}

func envString(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if value, err := strconv.Atoi(os.Getenv(name)); err == nil && value > 0 {
		return value
	}
	return fallback
}

func parseRoutes(value string) map[string]string {
	routes := map[string]string{}
	for _, entry := range strings.Split(value, ",") {
		domain, target, ok := strings.Cut(strings.TrimSpace(entry), "=")
		if ok && domain != "" && target != "" {
			routes[strings.ToLower(domain)] = target
		}
	}
	return routes
}

func (s *service) authorized(r *http.Request) bool {
	if s.cfg.token == "" {
		return true
	}
	provided, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok {
		return false
	}
	hash := sha256.Sum256([]byte(provided))
	return subtle.ConstantTimeCompare(hash[:], s.tokenHash[:]) == 1
}

func (s *service) handleDeliver(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, msgUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.maxBodyBytes)

	var req deliverRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf(msgTooLarge, s.cfg.maxBodyBytes))
			return
		}
		writeError(w, http.StatusBadRequest, fmt.Sprintf(msgInvalidJSON, err))
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.Raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf(msgInvalidBase64, err))
		return
	}
	if len(req.To) == 0 {
		writeError(w, http.StatusBadRequest, msgNoRecipients)
		return
	}
	for _, address := range append([]string{req.From}, req.To...) {
		if strings.ContainsAny(address, "\r\n<> ") {
			writeError(w, http.StatusBadRequest, fmt.Sprintf(msgInvalidAddress, address))
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.cfg.sessionTimeout)
	defer cancel()
	writeJSON(w, http.StatusOK, map[string][]result{"results": s.deliver(ctx, req.From, req.To, raw)})
}

func (s *service) deliver(ctx context.Context, from string, recipients []string, raw []byte) []result {
	groups := map[string][]string{}
	var order []string
	for _, rcpt := range recipients {
		domain := ""
		if at := strings.LastIndex(rcpt, "@"); at > 0 {
			domain = strings.ToLower(rcpt[at+1:])
		}
		if _, seen := groups[domain]; !seen {
			order = append(order, domain)
		}
		groups[domain] = append(groups[domain], rcpt)
	}

	out := make([][]result, len(order))
	var wg sync.WaitGroup
	for i, domain := range order {
		wg.Add(1)
		go func(i int, domain string) {
			defer wg.Done()
			select {
			case s.limiter <- struct{}{}:
				defer func() { <-s.limiter }()
			case <-ctx.Done():
				out[i] = failAll(groups[domain], true, statusCancelled, fmt.Sprintf(msgCancelled, ctx.Err()), "")
				return
			}
			out[i] = s.deliverDomain(ctx, domain, from, groups[domain], raw)
		}(i, domain)
	}
	wg.Wait()

	var results []result
	for _, part := range out {
		results = append(results, part...)
	}
	return results
}

func (s *service) deliverDomain(ctx context.Context, domain, from string, rcpts []string, raw []byte) []result {
	if domain == "" {
		return failAll(rcpts, false, statusBadAddress, msgInvalidRecipient, "")
	}

	targets, failure := s.targets(ctx, domain)
	if failure != nil {
		return failAll(rcpts, failure.Temporary, failure.Status, failure.Response, "")
	}

	var lastErr error
	for _, target := range targets {
		results, err := s.deliverHost(ctx, target, from, rcpts, raw, true)
		if errors.Is(err, errStartTLS) {
			results, err = s.deliverHost(ctx, target, from, rcpts, raw, false)
		}
		if err == nil {
			return results
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return failAll(rcpts, true, statusMXUnreachable, fmt.Sprintf(msgMXUnreachable, domain, lastErr), "")
}

func (s *service) targets(ctx context.Context, domain string) ([]string, *result) {
	if route, ok := s.cfg.routes[domain]; ok {
		return []string{route}, nil
	}

	mxs, err := net.DefaultResolver.LookupMX(ctx, domain)
	if err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return nil, &result{Temporary: false, Status: statusNoMX, Response: fmt.Sprintf(msgNoMX, domain)}
		}
		return nil, &result{Temporary: true, Status: statusDNSFailure, Response: fmt.Sprintf(msgMXLookupFailed, domain, err)}
	}
	if len(mxs) == 0 {
		return nil, &result{Temporary: false, Status: statusNoMX, Response: fmt.Sprintf(msgNoMX, domain)}
	}
	if len(mxs) == 1 && strings.Trim(mxs[0].Host, ".") == "" {
		return nil, &result{Temporary: false, Status: statusNullMX, Response: fmt.Sprintf(msgNullMX, domain)}
	}

	sort.SliceStable(mxs, func(a, b int) bool { return mxs[a].Pref < mxs[b].Pref })
	targets := make([]string, 0, len(mxs))
	for _, mx := range mxs {
		targets = append(targets, net.JoinHostPort(strings.TrimSuffix(mx.Host, "."), s.cfg.smtpPort))
	}
	return targets, nil
}

func (s *service) deliverHost(ctx context.Context, target, from string, rcpts []string, raw []byte, useTLS bool) ([]result, error) {
	host, _, err := net.SplitHostPort(target)
	if err != nil {
		host = target
		target = net.JoinHostPort(target, s.cfg.smtpPort)
	}

	dialer := net.Dialer{Timeout: s.cfg.connectTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", target)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(s.cfg.sessionTimeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	_ = conn.SetDeadline(deadline)

	client, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return nil, err
	}
	defer client.Close()

	if err := client.Hello(s.cfg.ehlo); err != nil {
		return nil, err
	}
	if ok, _ := client.Extension("STARTTLS"); ok && useTLS {
		// Opportunistic TLS for MX delivery: encrypt when offered, the same as Postfix "may".
		if err := client.StartTLS(&tls.Config{ServerName: host, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}); err != nil {
			return nil, fmt.Errorf("%w: %v", errStartTLS, err)
		}
	}

	if err := client.Mail(from); err != nil {
		return failFromError(rcpts, host, err), nil
	}

	results := make([]result, 0, len(rcpts))
	accepted := make([]string, 0, len(rcpts))
	for _, rcpt := range rcpts {
		if err := client.Rcpt(rcpt); err != nil {
			results = append(results, resultFromError(rcpt, host, err))
			continue
		}
		accepted = append(accepted, rcpt)
	}
	if len(accepted) == 0 {
		_ = client.Quit()
		return results, nil
	}

	writer, err := client.Data()
	if err != nil {
		return append(results, failFromError(accepted, host, err)...), nil
	}
	if _, err := writer.Write(raw); err != nil {
		_ = writer.Close()
		return append(results, failFromError(accepted, host, err)...), nil
	}
	if err := writer.Close(); err != nil {
		return append(results, failFromError(accepted, host, err)...), nil
	}
	_ = client.Quit()

	for _, rcpt := range accepted {
		results = append(results, result{Recipient: rcpt, Success: true, Status: statusDelivered, Response: msgAccepted, RemoteMTA: host})
	}
	return results, nil
}

func resultFromError(rcpt, host string, err error) result {
	var protocolErr *textproto.Error
	if errors.As(err, &protocolErr) {
		temporary := protocolErr.Code < 500
		status := enhancedStatus.FindString(protocolErr.Msg)
		if status == "" {
			status = statusPermanent
			if temporary {
				status = statusTemporary
			}
		}
		return result{
			Recipient: rcpt,
			Temporary: temporary,
			Status:    status,
			Response:  fmt.Sprintf("%d %s", protocolErr.Code, protocolErr.Msg),
			RemoteMTA: host,
		}
	}
	return result{Recipient: rcpt, Temporary: true, Status: statusTemporary, Response: err.Error(), RemoteMTA: host}
}

func failFromError(rcpts []string, host string, err error) []result {
	results := make([]result, 0, len(rcpts))
	for _, rcpt := range rcpts {
		results = append(results, resultFromError(rcpt, host, err))
	}
	return results
}

func failAll(rcpts []string, temporary bool, status, response, host string) []result {
	results := make([]result, 0, len(rcpts))
	for _, rcpt := range rcpts {
		results = append(results, result{Recipient: rcpt, Temporary: temporary, Status: status, Response: response, RemoteMTA: host})
	}
	return results
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
