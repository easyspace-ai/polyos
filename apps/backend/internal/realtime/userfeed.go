package realtime

import (
	"context"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	polyauth "github.com/drinkthere/polymarket-sdk/polymarket/auth"
	userws "github.com/drinkthere/polymarket-sdk/polymarket/ws/user"
	"github.com/drinkthere/polyserver/internal/models"
	"github.com/sirupsen/logrus"
)

// AccountProvider returns the current default account for the user websocket.
type AccountProvider func() (models.AccountRecord, bool)

// UserEventHandler is called when user order/trade websocket events arrive.
type UserEventHandler func(context.Context)

// WSTimeoutProvider returns connect/subscribe timeouts for the user websocket.
type WSTimeoutProvider func() (connect time.Duration, subscribe time.Duration)

// UserFeed owns the authenticated CLOB user websocket.
type UserFeed struct {
	accountProvider AccountProvider
	timeoutProvider WSTimeoutProvider
	handler         UserEventHandler
	proxyURL        *url.URL
}

// NewUserFeed creates a CLOB user websocket feed.
func NewUserFeed(provider AccountProvider, timeoutProvider WSTimeoutProvider, handler UserEventHandler) *UserFeed {
	return &UserFeed{accountProvider: provider, timeoutProvider: timeoutProvider, handler: handler}
}

// SetProxy configures the HTTP/WS proxy for Polymarket outbound traffic.
func (u *UserFeed) SetProxy(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		u.proxyURL = nil
		return nil
	}
	p, err := url.Parse(raw)
	if err != nil {
		return err
	}
	u.proxyURL = p
	return nil
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
		if !sleepOrDone(ctx, 5*time.Second+jitter(2*time.Second)) {
			return
		}
	}
}

func (u *UserFeed) session(ctx context.Context, acc models.AccountRecord) error {
	connTimeout, subTimeout := u.wsTimeouts()
	dialer := &websocket.Dialer{HandshakeTimeout: connTimeout}
	if u.proxyURL != nil {
		dialer.Proxy = http.ProxyURL(u.proxyURL)
	}
	client, err := userws.NewClient(userws.Config{
		URL:              userWSEndpoint(),
		Dialer:           dialer,
		WriteTimeout:     5 * time.Second,
		PingInterval:     15 * time.Second,
		Reconnect:        true,
		ReconnectBackoff: 2 * time.Second,
	})
	if err != nil {
		return err
	}
	defer func() {
		if err := client.Close(); err != nil {
			logrus.WithError(err).WithField("component", "user_ws").Debug("close user websocket failed")
		}
	}()
	connectCtx, cancel := context.WithTimeout(ctx, connTimeout)
	defer cancel()
	if err := client.Connect(connectCtx); err != nil {
		return err
	}
	creds := polyauth.APICredentials{Key: acc.APIKey, Secret: acc.APISecret, Passphrase: acc.APIPassphrase}
	subCtx, subCancel := context.WithTimeout(ctx, subTimeout)
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
			runCtx, runCancel := context.WithTimeout(ctx, 45*time.Second)
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

func (u *UserFeed) wsTimeouts() (connect time.Duration, subscribe time.Duration) {
	connect = 15 * time.Second
	subscribe = 10 * time.Second
	if u.timeoutProvider != nil {
		c, s := u.timeoutProvider()
		if c > 0 {
			connect = c
		}
		if s > 0 {
			subscribe = s
		}
	}
	if connect < 5*time.Second {
		connect = 5 * time.Second
	}
	if connect > 60*time.Second {
		connect = 60 * time.Second
	}
	if subscribe < 3*time.Second {
		subscribe = 3 * time.Second
	}
	if subscribe > 30*time.Second {
		subscribe = 30 * time.Second
	}
	return connect, subscribe
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

// jitter returns a random duration up to max, used to spread reconnect storms.
func jitter(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	return time.Duration(rand.Int63n(int64(max)))
}
