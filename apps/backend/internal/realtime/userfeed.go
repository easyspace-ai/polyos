package realtime

import (
	"context"
	"os"
	"strings"
	"time"

	polyauth "github.com/drinkthere/polymarket-sdk/polymarket/auth"
	userws "github.com/drinkthere/polymarket-sdk/polymarket/ws/user"
	"github.com/drinkthere/polyserver/internal/models"
	"github.com/sirupsen/logrus"
)

// AccountProvider returns the current default account for the user websocket.
type AccountProvider func() (models.AccountRecord, bool)

// UserEventHandler is called when user order/trade websocket events arrive.
type UserEventHandler func(context.Context)

// UserFeed owns the authenticated CLOB user websocket.
type UserFeed struct {
	accountProvider AccountProvider
	handler         UserEventHandler
}

// NewUserFeed creates a CLOB user websocket feed.
func NewUserFeed(provider AccountProvider, handler UserEventHandler) *UserFeed {
	return &UserFeed{accountProvider: provider, handler: handler}
}

// Run keeps the user websocket connected for the current default account.
func (u *UserFeed) Run(ctx context.Context) {
	var currentAccountID string
	for ctx.Err() == nil {
		acc, ok := u.accountProvider()
		if !ok || !acc.HasCLOBCredentials() {
			logrus.WithField("component", "user_ws").Info("user websocket idle: no default account credentials")
			if !sleepOrDone(ctx, 10*time.Second) {
				return
			}
			continue
		}
		if currentAccountID != acc.ID {
			currentAccountID = acc.ID
			logrus.WithFields(logrus.Fields{
				"component":  "user_ws",
				"account_id": acc.ID,
			}).Info("user websocket selected default account")
		}
		if err := u.session(ctx, acc); err != nil && ctx.Err() == nil {
			logrus.WithError(err).WithFields(logrus.Fields{
				"component":  "user_ws",
				"account_id": acc.ID,
			}).Warn("user websocket session ended")
		}
		if !sleepOrDone(ctx, 2*time.Second) {
			return
		}
	}
}

func (u *UserFeed) session(ctx context.Context, acc models.AccountRecord) error {
	client, err := userws.NewClient(userws.Config{
		URL:              userWSEndpoint(),
		WriteTimeout:     5 * time.Second,
		PingInterval:     15 * time.Second,
		Reconnect:        true,
		ReconnectBackoff: 500 * time.Millisecond,
	})
	if err != nil {
		return err
	}
	defer func() {
		if err := client.Close(); err != nil {
			logrus.WithError(err).WithField("component", "user_ws").Debug("close user websocket failed")
		}
	}()
	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := client.Connect(connectCtx); err != nil {
		return err
	}
	creds := polyauth.APICredentials{Key: acc.APIKey, Secret: acc.APISecret, Passphrase: acc.APIPassphrase}
	subCtx, subCancel := context.WithTimeout(ctx, 5*time.Second)
	defer subCancel()
	if err := client.Subscribe(subCtx, userws.SubscribeRequest{
		Credentials: creds,
		Markets:     []string{},
		InitialDump: true,
	}); err != nil {
		return err
	}
	logrus.WithFields(logrus.Fields{
		"component":  "user_ws",
		"endpoint":   userWSEndpoint(),
		"account_id": acc.ID,
	}).Info("user websocket subscribed")
	for ctx.Err() == nil {
		readCtx, readCancel := context.WithTimeout(ctx, 90*time.Second)
		msg, err := client.ReadMessage(readCtx)
		readCancel()
		if err != nil {
			return err
		}
		if len(msg.Events) == 0 {
			continue
		}
		u.logEvents(acc.ID, msg.Events)
		if u.handler != nil {
			runCtx, runCancel := context.WithTimeout(ctx, 30*time.Second)
			u.handler(runCtx)
			runCancel()
		}
	}
	return ctx.Err()
}

func (u *UserFeed) logEvents(accountID string, events []userws.Event) {
	for _, event := range events {
		if event.Order != nil {
			logrus.WithFields(logrus.Fields{
				"component":  "user_ws",
				"account_id": accountID,
				"kind":       "order",
				"order_id":   event.Order.ID,
				"asset_id":   truncateID(event.Order.AssetID),
				"side":       event.Order.Side,
				"status":     event.Order.Status,
				"type":       event.Order.Type,
			}).Info("user websocket order event")
		}
		if event.Fill != nil {
			logrus.WithFields(logrus.Fields{
				"component":  "user_ws",
				"account_id": accountID,
				"kind":       "trade",
				"trade_id":   event.Fill.ID,
				"asset_id":   truncateID(event.Fill.AssetID),
				"side":       event.Fill.Side,
				"status":     event.Fill.Status,
				"size":       event.Fill.Size,
				"price":      event.Fill.Price,
			}).Info("user websocket trade event")
		}
	}
}

func userWSEndpoint() string {
	if endpoint := strings.TrimSpace(os.Getenv("CLOB_USER_WS_URL")); endpoint != "" {
		return endpoint
	}
	if base := strings.TrimSpace(os.Getenv("CLOB_WS_URL")); base != "" {
		return strings.TrimRight(base, "/") + "/ws/user"
	}
	return "wss://ws-subscriptions-clob.polymarket.com/ws/user"
}

func truncateID(v string) string {
	if len(v) <= 16 {
		return v
	}
	return v[:12] + "..."
}

func sleepOrDone(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
