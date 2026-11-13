package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ProtonMail/gluon"
	"github.com/pkg/profile"
	"github.com/sirupsen/logrus"

	factory "imap/core"
	"imap/core/connector"
	"imap/internal/conf"
	"imap/internal/control"
	"imap/internal/directorykind"
	"imap/internal/filing"
	"imap/internal/lmtp"
	"imap/internal/quota"
	"imap/internal/router"
	"imap/internal/storage"
	"imap/internal/tlscert"
)

var version = "prototype"

var (
	cpuProfileFlag   = flag.Bool("profile-cpu", false, "Enable CPU profiling.")
	memProfileFlag   = flag.Bool("profile-mem", false, "Enable Memory profiling.")
	blockProfileFlag = flag.Bool("profile-lock", false, "Enable lock profiling.")
	profilePathFlag  = flag.String("profile-path", "", "Path where to write profile data.")
	configFlag       = flag.String("config", env("IMAP_CONFIG", "conf/imap.xml"), "Path to imap.xml.")
	socketFlag       = flag.String("socket", env("IMAP_CONTROL_SOCKET", control.DefaultSocket()), "Control socket used by imapctl.")
)

func classifyDeliveryError(err error) lmtp.Reply {
	switch {
	case errors.Is(err, factory.ErrNotIMAPUser):
		return lmtp.Reply{Code: 550, Status: "5.1.1", Text: "no such mailbox"}
	case errors.Is(err, quota.ErrExceeded):
		return lmtp.Reply{Code: 552, Status: "5.2.2", Text: "mailbox is over quota"}
	case errors.Is(err, storage.ErrMailboxNotFound):
		return lmtp.Reply{Code: 550, Status: "5.2.0", Text: "mailbox not found"}
	case errors.Is(err, connector.ErrInvalidMessage):
		return lmtp.Reply{Code: 554, Status: "5.6.0", Text: "message cannot be parsed"}
	default:
		return lmtp.Reply{Code: 451, Status: "4.3.0", Text: "temporary failure, try again later"}
	}
}

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

	quotas := quota.NewManager(cfg.Quota, engine)

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
	defer instance.Close()

	instance.SetFilingRules(func() filing.Rules { return holder.Current().Delivery })
	err = instance.InitializeUsers(ctx)
	if err != nil {
		logrus.WithError(err).Fatal("Failed to initialize IMAP users")
	}

	r := router.New()
	deps := router.Deps{
		Conf:      holder,
		Directory: dir,
		Quota:     quotas,
		Gluon:     instance,
		Mail:      instance,
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

	var lmtpServer *lmtp.Server
	if cfg.LMTP.Enabled() {
		ln, err := net.Listen("tcp", cfg.LMTP.Listen)
		if err != nil {
			logrus.WithError(err).Fatal("Failed to listen for LMTP")
		}
		lmtpServer = &lmtp.Server{
			Backend:  instance,
			Hostname: "imap",
			Allowed:  func(a netip.Addr) bool { return holder.Current().LMTP.Allows(a) },
			MaxSize:  control.MaxRequestBytes,
			Classify: classifyDeliveryError,
		}
		go func() {
			if err := lmtpServer.Serve(ln); err != nil {
				logrus.WithError(err).Error("LMTP listener stopped")
			}
		}()
		logrus.Infof("LMTP is listening on %v", ln.Addr())
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
	if lmtpServer != nil {
		lmtpServer.Shutdown()
	}

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
