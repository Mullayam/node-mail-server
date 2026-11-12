package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ProtonMail/gluon"
	"github.com/pkg/profile"
	"github.com/sirupsen/logrus"

	factory "imap/core"
	"imap/internal/conf"
	"imap/internal/control"
	"imap/internal/directorykind"
	"imap/internal/quota"
	"imap/internal/router"
	"imap/internal/storage"
	"imap/internal/tlscert"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "prototype"

var (
	cpuProfileFlag   = flag.Bool("profile-cpu", false, "Enable CPU profiling.")
	memProfileFlag   = flag.Bool("profile-mem", false, "Enable Memory profiling.")
	blockProfileFlag = flag.Bool("profile-lock", false, "Enable lock profiling.")
	profilePathFlag  = flag.String("profile-path", "", "Path where to write profile data.")
	configFlag       = flag.String("config", env("IMAP_CONFIG", "conf/imap.xml"), "Path to imap.xml.")
	socketFlag       = flag.String("socket", env("IMAP_CONTROL_SOCKET", control.DefaultSocket()), "Control socket used by imapctl.")
)

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	flag.Parse()

	if *cpuProfileFlag {
		p := profile.Start(profile.CPUProfile, profile.ProfilePath(*profilePathFlag))
		defer p.Stop()
	}

	if *memProfileFlag {
		p := profile.Start(profile.MemProfile, profile.MemProfileAllocs, profile.ProfilePath(*profilePathFlag))
		defer p.Stop()
	}

	if *blockProfileFlag {
		p := profile.Start(profile.BlockProfile, profile.ProfilePath(*profilePathFlag))
		defer p.Stop()
	}

	if level, err := logrus.ParseLevel(os.Getenv("GLUON_LOG_LEVEL")); err == nil {
		logrus.SetLevel(level)
	}

	// 1. imap.xml: listen address, data dir, directory kind, storage engine, quota.
	holder, err := conf.NewHolder(*configFlag)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			logrus.Fatalf("%s not found. Copy conf/imap.example.xml to conf/imap.xml and edit it.", *configFlag)
		}
		logrus.WithError(err).Fatalf("Invalid %s", *configFlag)
	}
	cfg := holder.Current()
	for _, w := range cfg.Warnings {
		logrus.Warn(w)
	}

	// 2. Storage engine (where mail lives) and directory (who the users are).
	engine, err := storage.Open(cfg.Storage.Name, cfg.Storage.Options)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to open storage engine")
	}
	defer engine.Close()

	dir, err := directorykind.Open(cfg.Directory.Name, cfg.Directory.Options)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to open directory")
	}
	defer dir.Close()
	if err := dir.Load(ctx); err != nil {
		logrus.WithError(err).Fatal("Failed to load users")
	}

	// 3. Quota: defaults from imap.xml, usage from the storage engine.
	quotas := quota.NewManager(cfg.Quota, engine)

	// 4. Gluon.
	dataDir := env("GLUON_DIR", cfg.DataDir)
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		logrus.WithError(err).Fatal("Failed to create data dir")
	}
	opts := []gluon.Option{
		gluon.WithLogger(
			logrus.StandardLogger().WriterLevel(logrus.TraceLevel),
			logrus.StandardLogger().WriterLevel(logrus.TraceLevel),
		),
		gluon.WithDataDir(dataDir),
		gluon.WithDatabaseDir(dataDir),
	}

	// TLS: when <tls cert key> is set, offer STARTTLS on the plain port and
	// listen on 993 with implicit TLS. The certificate reloads with imapctl.
	var certs *tlscert.Store
	if cfg.TLS.Enabled() {
		certs, err = tlscert.Load(cfg.TLS.Cert, cfg.TLS.Key)
		if err != nil {
			logrus.WithError(err).Fatal("Failed to load the TLS certificate")
		}
		opts = append(opts, gluon.WithTLS(certs.Config()))
	}

	server, err := gluon.New(opts...)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to create server")
	}

	instance, err := factory.NewConnectorFactory(server, dir, engine, quotas, dataDir)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to create connector factory")
	}
	err = instance.InitializeUsers(ctx)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to initialize IMAP users")
	}

	// 5. Admin router, reachable through imapctl on the control socket.
	r := router.New()
	deps := router.Deps{
		Conf:      holder,
		Directory: dir,
		Quota:     quotas,
		Gluon:     instance,
		Version:   version,
		Started:   time.Now(),
	}
	if certs != nil {
		deps.TLS = certs
	}
	router.RegisterAdmin(r, deps)
	dispatch := func(ctx context.Context, command string, args map[string]string) (any, error) {
		return r.Dispatch(ctx, command, router.Args(args))
	}
	go func() {
		if err := control.Serve(ctx, *socketFlag, dispatch); err != nil {
			logrus.WithError(err).Error("Control socket stopped")
		}
	}()

	// SIGHUP reloads too, so "docker kill -s HUP <container>" works.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	go func() {
		for {
			select {
			case <-hup:
				if _, err := dispatch(ctx, "reload", nil); err != nil {
					logrus.WithError(err).Error("Reload failed")
				} else {
					logrus.Info("Reloaded configuration")
				}
			case <-ctx.Done():
				return
			}
		}
	}()

	// 6. Listen. GLUON_HOST overrides the address in imap.xml.
	host := env("GLUON_HOST", cfg.Listen)

	listener, err := net.Listen("tcp", host)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to listen")
	}

	logrus.Infof("Server is listening on %v", listener.Addr())
	logrus.Infof("Admin: imapctl -socket %s routes", *socketFlag)

	if err := server.Serve(ctx, listener); err != nil {
		logrus.WithError(err).Fatal("Failed to serve")
	}

	var tlsListener net.Listener
	if certs != nil {
		raw, err := net.Listen("tcp", cfg.TLS.Listen)
		if err != nil {
			logrus.WithError(err).Fatal("Failed to listen for TLS")
		}
		tlsListener = tls.NewListener(raw, certs.Config())
		if err := server.Serve(ctx, tlsListener); err != nil {
			logrus.WithError(err).Fatal("Failed to serve TLS")
		}
		logrus.Infof("Server is listening on %v (TLS, certificate valid until %s)", raw.Addr(), certs.NotAfter().Format(time.DateOnly))
	}

	go func() {
		for err := range server.GetErrorCh() {
			logrus.WithError(err).Error("Error while serving")
		}
	}()

	<-ctx.Done()
	logrus.Info("Shutting down")

	closeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Close(closeCtx); err != nil {
		fmt.Fprintln(os.Stderr, "close:", err)
	}
	for _, l := range []net.Listener{listener, tlsListener} {
		if l == nil {
			continue
		}
		if err := l.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			logrus.WithError(err).Error("Failed to close listener")
		}
	}
}
