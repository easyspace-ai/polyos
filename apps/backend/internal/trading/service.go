package trading

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	polyauth "github.com/drinkthere/polymarket-sdk/polymarket/auth"
	"github.com/drinkthere/polymarket-sdk/polymarket/balances"
	"github.com/drinkthere/polymarket-sdk/polymarket/data"
	"github.com/drinkthere/polymarket-sdk/polymarket/httpx"
	"github.com/drinkthere/polymarket-sdk/polymarket/markets"
	"github.com/drinkthere/polymarket-sdk/polymarket/orders"
	"github.com/drinkthere/polyserver/internal/models"
	"github.com/drinkthere/polyserver/internal/positions"
	"github.com/sirupsen/logrus"
)

const (
	polygonChainID          = 137
	gnosisSafeSignatureType = 3
)

// Service wraps authenticated CLOB, Data API, and public market clients.
type Service struct {
	mu          sync.Mutex
	idempotency map[string]map[string]any
}

// New creates a trading service.
func New() *Service {
	return &Service{idempotency: map[string]map[string]any{}}
}

// PlaceOrder submits a market-like CLOB order for the default account.
func (s *Service) PlaceOrder(ctx context.Context, acc models.AccountRecord, req models.PlaceOrderRequest, idempotencyKey string) (map[string]any, error) {
	if cached := s.idempotencyGet(idempotencyKey); cached != nil {
		return cached, nil
	}
	tokenID := strings.TrimSpace(req.TokenID)
	if tokenID == "" {
		return nil, fmt.Errorf("tokenId is required")
	}
	if req.AmountUSDC <= 0 {
		return nil, fmt.Errorf("amountUsdc must be > 0")
	}
	side := strings.ToUpper(strings.TrimSpace(ptrString(req.Side, "BUY")))
	if side != "BUY" && side != "SELL" {
		return nil, fmt.Errorf("side must be BUY or SELL")
	}
	if req.DryRun {
		resp := map[string]any{"orderID": "dry-run", "status": "DRY_RUN", "success": true}
		s.idempotencyPut(idempotencyKey, resp)
		return resp, nil
	}
	price, tickSize, negRisk, err := s.executionPrice(ctx, tokenID, side, req.Price)
	if err != nil {
		return nil, err
	}
	size := quantizeShares(req.AmountUSDC / price)
	if size <= 0 {
		return nil, fmt.Errorf("amountUsdc too small for current price")
	}
	client, signer, creds, err := s.orderClient(acc)
	if err != nil {
		return nil, err
	}
	orderSide := orders.SideBuy
	if side == "SELL" {
		orderSide = orders.SideSell
	}
	signed, err := signer.CreateSignedOrder(polyauth.CreateSignedOrderRequest{
		TokenID:  tokenID,
		Price:    price,
		Size:     size,
		Side:     orderSide,
		TickSize: tickSize,
		NegRisk:  negRisk,
	})
	if err != nil {
		return nil, err
	}
	orderType := orderType(ptrString(req.OrderType, "FAK"))
	resp, err := client.PlaceMakerOrder(ctx, orders.PlaceMakerOrderRequest{
		Credentials: creds,
		OrderType:   orderType,
		Order:       signed,
	})
	if err != nil {
		return nil, err
	}
	out := map[string]any{
		"orderID":       resp.OrderID,
		"status":        resp.Status,
		"success":       resp.Success,
		"errorMsg":      resp.ErrorMsg,
		"makingAmount":  resp.MakingAmount,
		"takingAmount":  resp.TakingAmount,
		"price":         strconv.FormatFloat(price, 'f', -1, 64),
		"original_size": strconv.FormatFloat(size, 'f', 2, 64),
		"asset_id":      tokenID,
	}
	s.idempotencyPut(idempotencyKey, out)
	logrus.WithFields(logrus.Fields{
		"component":  "orders",
		"account_id": acc.ID,
		"token_id":   tokenID,
		"side":       side,
		"order_id":   resp.OrderID,
		"success":    resp.Success,
	}).Info("order submitted")
	return out, nil
}

// MarketSellShares submits a FAK sell order for an existing position.
func (s *Service) MarketSellShares(ctx context.Context, acc models.AccountRecord, tokenID string, shares float64, dryRun bool) (map[string]any, error) {
	tokenID = strings.TrimSpace(tokenID)
	if tokenID == "" {
		return nil, fmt.Errorf("tokenId is required")
	}
	if shares <= 0 {
		return nil, fmt.Errorf("shares must be > 0")
	}
	if dryRun {
		return map[string]any{"orderID": "dry-run-sell", "status": "DRY_RUN", "success": true}, nil
	}
	price, tickSize, negRisk, err := s.executionPrice(ctx, tokenID, "SELL", nil)
	if err != nil {
		return nil, err
	}
	size := quantizeShares(shares)
	if size <= 0 {
		return nil, fmt.Errorf("shares invalid after lot-size quantize")
	}
	client, signer, creds, err := s.orderClient(acc)
	if err != nil {
		return nil, err
	}
	signed, err := signer.CreateSignedOrder(polyauth.CreateSignedOrderRequest{
		TokenID:  tokenID,
		Price:    price,
		Size:     size,
		Side:     orders.SideSell,
		TickSize: tickSize,
		NegRisk:  negRisk,
	})
	if err != nil {
		return nil, err
	}
	resp, err := client.PlaceMakerOrder(ctx, orders.PlaceMakerOrderRequest{
		Credentials: creds,
		OrderType:   orders.OrderTypeFAK,
		Order:       signed,
	})
	if err != nil {
		return nil, err
	}
	out := map[string]any{
		"orderID":      resp.OrderID,
		"status":       resp.Status,
		"success":      resp.Success,
		"errorMsg":     resp.ErrorMsg,
		"makingAmount": resp.MakingAmount,
		"takingAmount": resp.TakingAmount,
	}
	logrus.WithFields(logrus.Fields{
		"component":  "orders",
		"account_id": acc.ID,
		"token_id":   tokenID,
		"shares":     size,
		"order_id":   resp.OrderID,
		"success":    resp.Success,
	}).Info("market sell submitted")
	return out, nil
}

// CancelAllOrders cancels all open CLOB orders for the account.
func (s *Service) CancelAllOrders(ctx context.Context, acc models.AccountRecord) (orders.CancelAllOrdersResponse, error) {
	client, _, creds, err := s.orderClient(acc)
	if err != nil {
		return orders.CancelAllOrdersResponse{}, err
	}
	return client.CancelAllOrders(ctx, orders.CancelAllOrdersRequest{Credentials: creds})
}

// ListOrders returns CLOB open orders.
func (s *Service) ListOrders(ctx context.Context, acc models.AccountRecord) (map[string]any, error) {
	client, _, creds, err := s.orderClient(acc)
	if err != nil {
		return nil, err
	}
	rows, err := client.GetOpenOrders(ctx, orders.GetOpenOrdersRequest{Credentials: creds})
	if err != nil {
		return nil, err
	}
	data, err := toJSONRows(rows)
	if err != nil {
		return nil, err
	}
	return map[string]any{"data": data, "next_cursor": "LTE="}, nil
}

// ListTrades returns CLOB user trade history.
func (s *Service) ListTrades(ctx context.Context, acc models.AccountRecord) (map[string]any, error) {
	client, _, creds, err := s.orderClient(acc)
	if err != nil {
		return nil, err
	}
	rows, err := client.GetUserTradesRaw(ctx, orders.GetUserTradesRawRequest{Credentials: creds})
	if err != nil {
		return nil, err
	}
	data := make([]json.RawMessage, 0, len(rows))
	data = append(data, rows...)
	return map[string]any{"data": data, "next_cursor": "LTE="}, nil
}

// BalanceUSDC fetches CLOB collateral balance.
func (s *Service) BalanceUSDC(ctx context.Context, acc models.AccountRecord) (float64, string, error) {
	client, creds, err := s.balanceClient(acc)
	if err != nil {
		return 0, "", err
	}
	resp, err := client.GetBalance(ctx, balances.GetBalanceRequest{
		Credentials: creds,
		AssetType:   balances.AssetTypeCollateral,
	})
	if err != nil {
		return 0, "", err
	}
	usdc := parseCollateralUSDC(resp.Balance)
	logrus.WithFields(logrus.Fields{
		"component": "balances",
		"balance":   resp.Balance,
		"allowance": resp.Allowance,
		"usdc":      usdc,
	}).Info("clob collateral balance loaded")
	return usdc, "CLOB", nil
}

// PortfolioValue returns current Data API portfolio value.
func (s *Service) PortfolioValue(ctx context.Context, acc models.AccountRecord) (float64, error) {
	addr := dataAPIAddress(acc)
	if addr == "" {
		return 0, fmt.Errorf("account address is empty")
	}
	client, err := data.DefaultClient()
	if err != nil {
		return 0, err
	}
	rows, err := client.GetPositions(ctx, data.PositionsRequest{User: addr, Limit: 200})
	if err != nil {
		return 0, err
	}
	var total float64
	for _, row := range rows {
		total += row.CurrentValue
	}
	return total, nil
}

// SyncPositionsFromDataAPI mirrors the Rust chain sync path:
// Data API positions become local monitored positions; missing local live positions are closed.
func (s *Service) SyncPositionsFromDataAPI(ctx context.Context, acc models.AccountRecord, store *positions.Store, defaultStopTrailPct float64, tiers []models.TierConfig) (map[string]int, error) {
	addr := dataAPIAddress(acc)
	if addr == "" {
		return nil, fmt.Errorf("account address is empty")
	}
	client, err := data.DefaultClient()
	if err != nil {
		return nil, err
	}
	rows, err := client.GetPositions(ctx, data.PositionsRequest{User: addr, Limit: 200})
	if err != nil {
		return nil, err
	}
	byToken := map[string]data.Position{}
	for _, row := range rows {
		if strings.TrimSpace(row.Asset) != "" {
			byToken[row.Asset] = row
		}
	}
	created, updated, closed := 0, 0, 0
	for tokenID, row := range byToken {
		shares := row.Size
		if row.Redeemable || shares <= 0 {
			if local, ok := findOpenByToken(store, tokenID); ok && !local.Paper {
				if _, _, err := store.Update(ctx, local.ID, func(p *models.Position) {
					p.State = "closed"
					p.MonitoringActive = false
				}); err == nil {
					closed++
				}
			}
			continue
		}
		cost, avg := costBasis(row)
		cur := normalizePrice(row.CurPrice)
		trail := stopTrailForPrice(avg, defaultStopTrailPct, tiers)
		if local, ok := findOpenByToken(store, tokenID); ok {
			needsUpdate := math.Abs(local.Shares-shares) > 1e-6 ||
				(local.CostUSDC <= 0 && cost > 0) ||
				(local.AvgEntryPrice <= 0 && avg > 0) ||
				math.Abs(local.StopTrailPct-trail) > 1e-6
			if needsUpdate {
				if _, _, err := store.Update(ctx, local.ID, func(p *models.Position) {
					p.Shares = shares
					if p.CostUSDC <= 0 && cost > 0 {
						p.CostUSDC = cost
					}
					if p.AvgEntryPrice <= 0 && avg > 0 {
						p.AvgEntryPrice = avg
					}
					p.StopTrailPct = trail
				}); err == nil {
					updated++
				}
			}
			continue
		}
		req := models.RegisterPositionRequest{
			MarketID:      firstNonEmpty(row.ConditionID, row.Asset),
			ConditionID:   stringPtr(row.ConditionID),
			EventID:       stringPtr(row.EventID),
			TokenID:       tokenID,
			Shares:        shares,
			AvgEntryPrice: avg,
			CostUSDC:      cost,
			StopTrailPct:  trail,
			OutcomeLabel:  stringPtr(row.Outcome),
			Paper:         false,
		}
		p, err := store.Register(ctx, req)
		if err != nil {
			return nil, err
		}
		if cur > p.HighWaterMark {
			_, _, _ = store.Update(ctx, p.ID, func(pos *models.Position) {
				pos.HighWaterMark = cur
				pos.External = true
				pos.AutoRegistered = true
			})
		} else {
			_, _, _ = store.Update(ctx, p.ID, func(pos *models.Position) {
				pos.External = true
				pos.AutoRegistered = true
			})
		}
		created++
	}
	for _, local := range store.ListOpen() {
		if local.Paper || strings.TrimSpace(local.TokenID) == "" {
			continue
		}
		if _, ok := byToken[local.TokenID]; ok {
			continue
		}
		if _, _, err := store.Update(ctx, local.ID, func(p *models.Position) {
			p.State = "closed"
			p.MonitoringActive = false
		}); err == nil {
			closed++
		}
	}
	out := map[string]int{
		"syncedCount":  created + updated + closed,
		"createdCount": created,
		"updatedCount": updated,
		"closedCount":  closed,
	}
	logrus.WithFields(logrus.Fields{
		"component": "chain_sync",
		"user":      addr,
		"created":   created,
		"updated":   updated,
		"closed":    closed,
		"returned":  len(rows),
	}).Info("data api positions synced")
	return out, nil
}

func (s *Service) executionPrice(ctx context.Context, tokenID, side string, override *float64) (float64, float64, bool, error) {
	tickSize := 0.01
	negRisk := false
	if override != nil && *override > 0 {
		return *override, tickSize, negRisk, nil
	}
	httpClient, err := httpx.New(httpx.ClientConfig{BaseURL: clobURL(), Timeout: 10 * time.Second})
	if err != nil {
		return 0, 0, false, err
	}
	marketClient, err := markets.NewClient(httpClient)
	if err != nil {
		return 0, 0, false, err
	}
	book, err := marketClient.GetOrderBook(ctx, tokenID)
	if err != nil {
		return 0, 0, false, err
	}
	if parsed, err := strconv.ParseFloat(book.TickSize, 64); err == nil && parsed > 0 {
		tickSize = parsed
	}
	negRisk = book.NegRisk
	var price float64
	if side == "SELL" {
		price = bestBookPrice(book.Bids)
	} else {
		price = bestBookPrice(book.Asks)
	}
	if price <= 0 {
		return 0, 0, false, fmt.Errorf("no executable %s price for token", side)
	}
	return price, tickSize, negRisk, nil
}

func (s *Service) orderClient(acc models.AccountRecord) (*orders.Client, *polyauth.Signer, polyauth.APICredentials, error) {
	httpClient, err := httpx.New(httpx.ClientConfig{BaseURL: clobURL(), Timeout: 30 * time.Second})
	if err != nil {
		return nil, nil, polyauth.APICredentials{}, err
	}
	cfg := authConfig(acc)
	client, err := orders.NewClient(httpClient, cfg)
	if err != nil {
		return nil, nil, polyauth.APICredentials{}, err
	}
	signer, err := polyauth.NewSigner(cfg)
	if err != nil {
		return nil, nil, polyauth.APICredentials{}, err
	}
	return client, signer, credentials(acc), nil
}

func (s *Service) balanceClient(acc models.AccountRecord) (*balances.Client, polyauth.APICredentials, error) {
	httpClient, err := httpx.New(httpx.ClientConfig{BaseURL: clobURL(), Timeout: 15 * time.Second})
	if err != nil {
		return nil, polyauth.APICredentials{}, err
	}
	client, err := balances.NewClient(httpClient, authConfig(acc))
	if err != nil {
		return nil, polyauth.APICredentials{}, err
	}
	return client, credentials(acc), nil
}

func authConfig(acc models.AccountRecord) polyauth.Config {
	return polyauth.Config{
		FunderAddress: acc.ProxyWalletAddress,
		PrivateKey:    acc.EVMPrivateKey,
		ChainID:       polygonChainID,
		SignatureType: gnosisSafeSignatureType,
		APIKey:        acc.APIKey,
		APISecret:     acc.APISecret,
		APIPassphrase: acc.APIPassphrase,
	}
}

func credentials(acc models.AccountRecord) polyauth.APICredentials {
	return polyauth.APICredentials{Key: acc.APIKey, Secret: acc.APISecret, Passphrase: acc.APIPassphrase}
}

func clobURL() string {
	if v := strings.TrimSpace(os.Getenv("CLOB_API_URL")); v != "" {
		return v
	}
	return "https://clob.polymarket.com"
}

func dataAPIAddress(acc models.AccountRecord) string {
	if v := strings.TrimSpace(acc.ProxyWalletAddress); v != "" {
		return v
	}
	return strings.TrimSpace(acc.EOAAddress)
}

func ptrString(v *string, fallback string) string {
	if v == nil || strings.TrimSpace(*v) == "" {
		return fallback
	}
	return *v
}

func orderType(raw string) orders.OrderType {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "FOK":
		return orders.OrderTypeFOK
	case "GTC":
		return orders.OrderTypeGTC
	case "GTD":
		return orders.OrderTypeGTD
	default:
		return orders.OrderTypeFAK
	}
}

func quantizeShares(v float64) float64 {
	return math.Floor(v*100) / 100
}

func bestBookPrice(levels []markets.BookLevel) float64 {
	if len(levels) == 0 {
		return 0
	}
	return levels[0].Price
}

func parseCollateralUSDC(raw string) float64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	if strings.ContainsAny(raw, ".eE") {
		v, _ := strconv.ParseFloat(raw, 64)
		return v
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0
	}
	return v / 1_000_000
}

func toJSONRows(v any) ([]map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func findOpenByToken(store *positions.Store, tokenID string) (models.Position, bool) {
	for _, p := range store.ListOpen() {
		if p.TokenID == tokenID {
			return p, true
		}
	}
	return models.Position{}, false
}

func normalizePrice(v float64) float64 {
	if v > 1.01 {
		return v / 100
	}
	return v
}

func costBasis(row data.Position) (float64, float64) {
	shares := row.Size
	avg := normalizePrice(row.AvgPrice)
	cost := row.InitialValue
	if cost <= 0 && shares > 0 && avg > 0 {
		cost = shares * avg
	}
	if cost <= 0 && row.TotalBought > 0 {
		cost = row.TotalBought
	}
	if cost <= 0 && row.CurrentValue > 0 {
		inferred := row.CurrentValue - row.CashPnl
		if inferred > 0 {
			cost = inferred
		}
	}
	if avg <= 0 && shares > 0 && cost > 0 {
		avg = cost / shares
	}
	return cost, avg
}

func stopTrailForPrice(price float64, fallback float64, tiers []models.TierConfig) float64 {
	if price > 1.01 {
		price = price / 100
	}
	trail := fallback
	for _, tier := range tiers {
		if price >= tier.Min && price <= tier.Max && tier.DefaultStopLoss > 0 {
			trail = tier.DefaultStopLoss / 100
			break
		}
	}
	if trail <= 0 {
		trail = models.DefaultRiskConfig().DefaultStopTrailPct
	}
	if trail > 0.99 {
		return 0.99
	}
	return trail
}

func stringPtr(v string) *string {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	return &v
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "external"
}

func (s *Service) idempotencyGet(key string) map[string]any {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.idempotency[key]
}

func (s *Service) idempotencyPut(key string, value map[string]any) {
	key = strings.TrimSpace(key)
	if key == "" {
		return
	}
	s.mu.Lock()
	s.idempotency[key] = value
	s.mu.Unlock()
}
