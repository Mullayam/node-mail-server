package factory

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/ProtonMail/gluon"

	"imap/core/connector"
	"imap/core/consts"
	"imap/internal/directorykind"
	"imap/internal/filing"
	"imap/internal/quota"
	"imap/internal/storage"
)

type ConnectorFactory struct {
	server         *gluon.Server
	dir            directorykind.Directory // the users (SMTP users + IMAP flag)
	engine         storage.Engine          // where the mail lives
	quota          *quota.Manager
	ids            *idStore                            // email -> Gluon user ID, kept across restarts
	userConnectors map[string]string                   // email -> gluonUserID, users loaded right now
	connectors     map[string]*connector.MyDBConnector // email -> its connector, for Deliver
	rules          func() filing.Rules                 // where Deliver files spam
	mu             sync.Mutex
}

func NewConnectorFactory(server *gluon.Server, dir directorykind.Directory, engine storage.Engine, q *quota.Manager, dataDir string) (*ConnectorFactory, error) {
	ids, err := openIDStore(filepath.Join(dataDir, "gluon-users.json"))
	if err != nil {
		return nil, err
	}
	cf := &ConnectorFactory{
		server:         server,
		dir:            dir,
		engine:         engine,
		quota:          q,
		ids:            ids,
		userConnectors: make(map[string]string),
		connectors:     make(map[string]*connector.MyDBConnector),
	}

	return cf, nil
}

func (cf *ConnectorFactory) InitializeUsers(ctx context.Context) error {
	// Load users from the directory who have IMAP enabled
	// and initialize their connectors in Gluon otherwise user not able to login,
	report, err := cf.SyncUsers(ctx)
	if err != nil {
		return err
	}
	for email, reason := range report.Failed {
		log.Printf("❌ Failed to initialize IMAP user %s: %s", email, reason)
	}
	log.Printf("✅ %d IMAP user(s) initialized", len(report.Loaded))
	return nil
}

// GetOrCreateUser registers one user with Gluon. The caller holds cf.mu.
func (cf *ConnectorFactory) GetOrCreateUser(ctx context.Context, email string, gluon_id *string) (string, error) {
	var gluonUserID string
	fresh := true // Gluon has no data for this user yet

	userConnector := connector.NewConnector(email, cf.dir, cf.engine, cf.quota)
	// If gluonID is provided, use it; otherwise, add a new Gluon user
	if gluon_id == nil {
		id, err := cf.server.AddUser(ctx, userConnector, consts.DefaultImapPass)
		if err != nil {
			return "", fmt.Errorf("failed to add user to Gluon: %w", err)
		}

		gluonUserID = id
		log.Printf("Dynamically added user: %s (Gluon ID: %s)", email, gluonUserID)
	} else {
		gluonUserID = *gluon_id
		isNew, err := cf.server.LoadUser(ctx, userConnector, gluonUserID, consts.DefaultImapPass)
		if err != nil {
			return "", fmt.Errorf("failed to load Gluon user %s: %w", email, err)
		}
		fresh = isNew
		if !isNew {
			log.Printf("✅ Loaded existing Gluon user: %s (%s)", email, gluonUserID)
		}
	}

	cf.userConnectors[email] = gluonUserID
	cf.connectors[email] = userConnector

	// Sync waits for Gluon to apply each update; do not let a stuck Gluon
	// hang start-up or a reload.
	syncCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := userConnector.Sync(syncCtx, fresh); err != nil {
		log.Printf("❌ Failed to sync user %s: %v", email, err)
		return "", fmt.Errorf("failed to sync user %s: %w", email, err)
	}
	log.Printf("→ IMAP user ready: %s (Gluon ID: %s)", email, gluonUserID)
	return gluonUserID, nil
}
