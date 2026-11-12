package factory

import (
	"context"
	"database/sql"

	"fmt"
	"log"

	"github.com/Mullayam/node-mail-server/server/connector"
	"github.com/Mullayam/node-mail-server/server/consts"
	"github.com/ProtonMail/gluon"
	"golang.org/x/time/rate"

	"sync"
)

type ConnectorFactory struct {
	db             *sql.DB
	server         *gluon.Server
	userConnectors map[string]string // email -> gluonUserID
	mu             sync.RWMutex
	redis          *cache.Cache
}

func NewConnectorFactory(db *sql.DB, server *gluon.Server, redis *cache.Cache) *ConnectorFactory {
	cf := &ConnectorFactory{
		db:             db,
		server:         server,
		userConnectors: make(map[string]string),
		redis:          redis,
	}

	return cf
}
func (cf *ConnectorFactory) InitializeUsers(ctx context.Context) error {
	// Load users from the database who have IMAP enabled
	// and initialize their connectors in Gluon otherwise user not able to login,
	users := []struct {
		EmailID string
		GluonID *string
	}{}

	for _, u := range users {
		log.Printf("→ Initializing IMAP user: %s", u.EmailID)
		gid, err := cf.GetOrCreateUser(ctx, u.EmailID, u.GluonID)
		if err != nil {
			log.Printf("❌ Failed to initialize IMAP user %s: %v", u.EmailID, err)
			continue
		}
		log.Printf("✅ IMAP user initialized: %s (Gluon ID: %s)", u.EmailID, gid)
	}
	return nil
}
func (cf *ConnectorFactory) GetOrCreateUser(ctx context.Context, email string, gluon_id *string) (string, error) {
	// Check if user is already loaded
	cf.mu.RLock()
	defer cf.mu.RUnlock()

	var gluonUserID string

	userConnector := connector.NewConnector(cf.db, email, cf.redis)
	// If gluonID is provided, use it; otherwise, try loading from DB
	if gluon_id == nil {
		gluonUserID, err := cf.server.AddUser(ctx, userConnector, consts.DefaultImapPass)
		if err != nil {
			return "", fmt.Errorf("failed to add user to Gluon: %w", err)
		}

		gluonUserID = gluonUserID
		log.Printf("Dynamically added user: %s (Gluon ID: %s)", email, gluonUserID)
	} else {
		gluonUserID := *gluon_id
		if exists, err := cf.server.LoadUser(ctx, userConnector, gluonUserID, consts.DefaultImapPass); err == nil && !exists {
			log.Printf("✅ Loaded existing Gluon user: %s (%s)", email, gluonUserID)
		}

	}

	cf.userConnectors[email] = gluonUserID
	if err := userConnector.Sync(ctx); err != nil {
		fmt.Printf("❌ Failed to sync user %s: %v", email, err)
		return "", fmt.Errorf("failed to sync user %s: %w", email, err)
	}
	log.Printf("→ IMAP user ready: %s (Gluon ID: %s)", email, gluonUserID)
	return gluonUserID, nil
}
