package realtime

import (
	"context"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	marketws "github.com/drinkthere/polymarket-sdk/polymarket/ws/market"
	"github.com/drinkthere/polyserver/internal/positions"
	"github.com/drinkthere/polyserver/internal/risk"
	"github.com/sirupsen/logrus"
)

// TickPublisher receives normalized tick maps for /ws/board.
type TickPublisher func(quotes map[string]any)

// TickHandler receives normalized ticks after the price book is updated.
type TickHandler func(ticks []risk.Tick)

// PriceFeed tracks desired token subscriptions and owns the upstream market websocket.
type PriceFeed struct {
	mu          sync.RWMutex
	boardTokens map[string]struct{}
	positions   *positions.Store
	priceBook   *risk.PriceBook
	publisher   TickPublisher
	tickHandler TickHandler
	changed     chan struct{}
}

// NewPriceFeed creates a PriceFeed.
func NewPriceFeed(positionStore *positions.Store, priceBook *risk.PriceBook) *PriceFeed {
	return &PriceFeed{
		boardTokens: map[string]struct{}{},
		positions:   positionStore,
		priceBook:   priceBook,
		changed:     make(chan struct{}, 1),
	}
}

// SetPublisher registers a frontend tick publisher.
func (p *PriceFeed) SetPublisher(publisher TickPublisher) {
	p.mu.Lock()
	p.publisher = publisher
	p.mu.Unlock()
	logrus.WithField("component", "price_feed").Debug("price feed publisher registered")
}

// SetTickHandler registers risk evaluation after market ticks.
func (p *PriceFeed) SetTickHandler(handler TickHandler) {
	p.mu.Lock()
	p.tickHandler = handler
	p.mu.Unlock()
	logrus.WithField("component", "price_feed").Debug("price feed tick handler registered")
}

// SetBoardTokens replaces the current frontend board token set.
func (p *PriceFeed) SetBoardTokens(tokens []string) {
	p.mu.Lock()
	next := map[string]struct{}{}
	for _, token := range tokens {
		if token != "" {
			next[token] = struct{}{}
		}
	}
	p.boardTokens = next
	p.mu.Unlock()
	logrus.WithFields(logrus.Fields{
		"component":   "price_feed",
		"source":      "board",
		"token_count": len(next),
	}).Info("board token set updated")
	p.signalChanged()
}

// DesiredTokens returns board and monitored position tokens.
func (p *PriceFeed) DesiredTokens() []string {
	p.mu.RLock()
	set := map[string]struct{}{}
	for token := range p.boardTokens {
		set[token] = struct{}{}
	}
	p.mu.RUnlock()
	if p.positions != nil {
		for _, pos := range p.positions.ListForPriceFeed() {
			if pos.TokenID != "" {
				set[pos.TokenID] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(set))
	for token := range set {
		out = append(out, token)
	}
	sort.Strings(out)
	return out
}

// Run owns the upstream market websocket lifecycle.
func (p *PriceFeed) Run(ctx context.Context) error {
	var currentKey string
	var cancel context.CancelFunc
	defer func() {
		if cancel != nil {
			cancel()
		}
	}()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		tokens := p.DesiredTokens()
		key := strings.Join(tokens, "\n")
		if key != currentKey {
			if cancel != nil {
				logrus.WithFields(logrus.Fields{
					"component": "price_feed",
					"reason":    "subscription_changed",
				}).Info("stopping current market websocket session")
				cancel()
				cancel = nil
			}
			currentKey = key
			if len(tokens) > 0 {
				logrus.WithFields(logrus.Fields{
					"component":   "price_feed",
					"token_count": len(tokens),
				}).Info("starting market websocket session")
				var feedCtx context.Context
				feedCtx, cancel = context.WithCancel(ctx)
				go p.runMarketWS(feedCtx, tokens)
			} else {
				logrus.WithField("component", "price_feed").Info("market websocket idle: no desired tokens")
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-p.changed:
		case <-ticker.C:
		}
	}
}

func (p *PriceFeed) runMarketWS(ctx context.Context, tokens []string) {
	backoff := 500 * time.Millisecond
	for ctx.Err() == nil {
		if err := p.marketWSSession(ctx, tokens); err != nil && ctx.Err() == nil {
			logrus.WithError(err).WithFields(logrus.Fields{
				"component":   "price_feed",
				"token_count": len(tokens),
				"backoff_ms":  backoff.Milliseconds(),
			}).Warn("market websocket session ended")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
			if backoff < 15*time.Second {
				backoff *= 2
			}
		}
	}
}

func (p *PriceFeed) marketWSSession(ctx context.Context, tokens []string) error {
	client, err := marketws.NewChannelClient(marketws.Config{
		URL:              marketWSEndpoint(),
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
			logrus.WithError(err).WithField("component", "price_feed").Debug("close market websocket failed")
		}
	}()
	logrus.WithFields(logrus.Fields{
		"component":   "price_feed",
		"endpoint":    marketWSEndpoint(),
		"token_count": len(tokens),
	}).Info("connecting market websocket")
	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := client.Connect(connectCtx); err != nil {
		return err
	}
	logrus.WithFields(logrus.Fields{
		"component":   "price_feed",
		"token_count": len(tokens),
	}).Info("market websocket connected")
	subCtx, subCancel := context.WithTimeout(ctx, 5*time.Second)
	defer subCancel()
	if err := client.Subscribe(subCtx, marketws.ChannelSubscribeRequest{AssetIDs: tokens}); err != nil {
		return err
	}
	logrus.WithFields(logrus.Fields{
		"component":   "price_feed",
		"token_count": len(tokens),
	}).Info("market websocket subscribed")
	for ctx.Err() == nil {
		readCtx, readCancel := context.WithTimeout(ctx, 45*time.Second)
		msg, err := client.Read(readCtx)
		readCancel()
		if err != nil {
			return err
		}
		events, err := marketws.DecodeEvents(msg)
		if err != nil {
			logrus.WithError(err).WithField("component", "price_feed").Debug("decode market websocket message failed")
			continue
		}
		p.applyMarketEvents(events)
	}
	return ctx.Err()
}

func (p *PriceFeed) applyMarketEvents(events []marketws.Event) {
	ticks := make([]risk.Tick, 0, len(events))
	for _, event := range events {
		if event.Book != nil {
			bid := parseLevel(event.Book.Bids)
			ask := parseLevel(event.Book.Asks)
			if bid > 0 && ask > 0 {
				ticks = append(ticks, risk.Tick{TokenID: event.Book.AssetID, Bid: bid, Ask: ask, Mid: (bid + ask) / 2})
			}
		}
		if event.BestBidAsk != nil {
			bid := parseFloat(event.BestBidAsk.BestBid)
			ask := parseFloat(event.BestBidAsk.BestAsk)
			if bid > 0 && ask > 0 {
				ticks = append(ticks, risk.Tick{TokenID: event.BestBidAsk.AssetID, Bid: bid, Ask: ask, Mid: (bid + ask) / 2})
			}
		}
		if event.PriceChange != nil {
			for _, change := range event.PriceChange.PriceChanges {
				bid := parseFloat(change.BestBid)
				ask := parseFloat(change.BestAsk)
				if bid > 0 && ask > 0 {
					ticks = append(ticks, risk.Tick{TokenID: change.AssetID, Bid: bid, Ask: ask, Mid: (bid + ask) / 2})
				}
			}
		}
	}
	if !p.priceBook.Apply(ticks) {
		return
	}
	logrus.WithFields(logrus.Fields{
		"component":  "price_feed",
		"tick_count": len(ticks),
	}).Debug("market ticks applied")
	quotes := map[string]any{}
	for _, tick := range ticks {
		quotes[tick.TokenID] = map[string]any{
			"tokenId":  tick.TokenID,
			"midpoint": tick.Mid,
			"bestBid":  tick.Bid,
			"bestAsk":  tick.Ask,
		}
	}
	p.mu.RLock()
	publisher := p.publisher
	handler := p.tickHandler
	p.mu.RUnlock()
	if publisher != nil && len(quotes) > 0 {
		publisher(quotes)
	}
	if handler != nil {
		go handler(append([]risk.Tick(nil), ticks...))
	}
}

func parseLevel(levels []marketws.BookLevel) float64 {
	if len(levels) == 0 {
		return 0
	}
	return parseFloat(levels[0].Price)
}

func parseFloat(raw string) float64 {
	v, _ := strconv.ParseFloat(raw, 64)
	return v
}

func marketWSEndpoint() string {
	if endpoint := os.Getenv("CLOB_MARKET_WS_URL"); endpoint != "" {
		return endpoint
	}
	return "wss://ws-subscriptions-clob.polymarket.com/ws/market"
}

func (p *PriceFeed) signalChanged() {
	select {
	case p.changed <- struct{}{}:
	default:
	}
}
