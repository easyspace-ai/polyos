package risk

import (
	"sync"
	"time"

	"github.com/drinkthere/polyserver/internal/models"
)

// Tick is a top-of-book price update.
type Tick struct {
	TokenID string
	Bid     float64
	Ask     float64
	Mid     float64
}

// PriceBook stores latest token prices.
type PriceBook struct {
	mu         sync.RWMutex
	byToken    map[string]Tick
	lastTickAt *time.Time
}

// NewPriceBook creates an empty price book.
func NewPriceBook() *PriceBook {
	return &PriceBook{byToken: map[string]Tick{}}
}

// Apply stores ticks and returns whether anything changed.
func (p *PriceBook) Apply(ticks []Tick) bool {
	if len(ticks) == 0 {
		return false
	}
	now := time.Now().UTC()
	p.mu.Lock()
	for _, tick := range ticks {
		if tick.TokenID == "" {
			continue
		}
		p.byToken[tick.TokenID] = tick
	}
	p.lastTickAt = &now
	p.mu.Unlock()
	return true
}

// LastTickAt returns the last update timestamp.
func (p *PriceBook) LastTickAt() *time.Time {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.lastTickAt == nil {
		return nil
	}
	v := *p.lastTickAt
	return &v
}

// Get returns the latest tick for one token.
func (p *PriceBook) Get(tokenID string) (Tick, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	t, ok := p.byToken[tokenID]
	return t, ok
}

// BuildSnapshot creates the frontend monitor snapshot.
func (p *PriceBook) BuildSnapshot(positions []models.Position, riskCfg models.RiskConfig) models.MonitorSnapshot {
	p.mu.RLock()
	defer p.mu.RUnlock()
	rows := make([]models.MonitorPositionRow, 0, len(positions))
	var totalCost, totalBid, totalMidPnL float64
	for _, pos := range positions {
		tick, ok := p.byToken[pos.TokenID]
		var bidPtr, askPtr, midPtr *float64
		mid := 0.0
		if ok {
			bid, ask, tickMid := tick.Bid, tick.Ask, tick.Mid
			bidPtr, askPtr, midPtr = &bid, &ask, &tickMid
			mid = tickMid
		}
		midValue := pos.Shares * mid
		totalCost += pos.CostUSDC
		if ok {
			totalBid += pos.Shares * tick.Bid
		}
		totalMidPnL += midValue - pos.CostUSDC
		rows = append(rows, models.MonitorPositionRow{
			ID:                pos.ID,
			MarketID:          pos.MarketID,
			EventID:           pos.EventID,
			TokenID:           pos.TokenID,
			Shares:            pos.Shares,
			CostUSDC:          pos.CostUSDC,
			StopTrailPct:      pos.StopTrailPct,
			OutcomeLabel:      pos.OutcomeLabel,
			State:             pos.State,
			MonitoringActive:  pos.MonitoringActive,
			HighWaterMark:     pos.HighWaterMark,
			Bid:               bidPtr,
			Ask:               askPtr,
			Mid:               midPtr,
			UnrealizedMidUSDC: midValue - pos.CostUSDC,
			Paper:             pos.Paper,
		})
	}
	pct := 0.0
	if totalCost > 0 {
		pct = totalMidPnL / totalCost
	}
	return models.MonitorSnapshot{
		TotalCostUSDC:     totalCost,
		TotalMarkValueBid: totalBid,
		UnrealizedMidUSDC: totalMidPnL,
		UnrealizedPctMid:  pct,
		Positions:         rows,
		Risk:              riskCfg,
		Timestamp:         time.Now().UTC().Format(time.RFC3339Nano),
	}
}
