package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/drinkthere/polyserver/internal/accounts"
	"github.com/drinkthere/polyserver/internal/board"
	"github.com/drinkthere/polyserver/internal/config"
	"github.com/drinkthere/polyserver/internal/models"
	"github.com/drinkthere/polyserver/internal/positions"
	"github.com/drinkthere/polyserver/internal/realtime"
	"github.com/drinkthere/polyserver/internal/risk"
	"github.com/drinkthere/polyserver/internal/storage"
	"github.com/drinkthere/polyserver/internal/trading"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

// App contains shared backend services.
type App struct {
	Config       config.Config
	Leagues      []models.LeagueConfig
	GlobalParams map[string]any
	Accounts     *accounts.Store
	Positions    *positions.Store
	PriceBook    *risk.PriceBook
	Board        *board.Service
	Hub          *realtime.Hub
	PriceFeed    *realtime.PriceFeed
	UserFeed     *realtime.UserFeed
	Trading      *trading.Service
	syncMu       sync.RWMutex
	syncStatus   map[string]any
}

// NewApp loads persisted state and wires services.
func NewApp(ctx context.Context, cfg config.Config) (*App, error) {
	var leaguesFile models.LeaguesFile
	if err := storage.LoadJSON(ctx, cfg.LeaguesPath(), &leaguesFile); err != nil {
		return nil, err
	}
	if len(leaguesFile.Leagues) == 0 {
		leaguesFile.Leagues = defaultLeagues()
		logrus.WithFields(logrus.Fields{
			"component": "basketball",
			"path":      cfg.LeaguesPath(),
			"count":     len(leaguesFile.Leagues),
		}).Warn("leagues file empty or missing; using built-in defaults")
	}
	var global map[string]any
	if err := storage.LoadJSON(ctx, cfg.GlobalParamsPath(), &global); err != nil {
		return nil, err
	}
	if global == nil {
		global = map[string]any{}
	}
	accountStore, err := accounts.Load(ctx, cfg.AccountsPath(), cfg.LegacyAccountsPath())
	if err != nil {
		return nil, err
	}
	positionStore, err := positions.Load(ctx, cfg.PositionsStatePath())
	if err != nil {
		return nil, err
	}
	priceBook := risk.NewPriceBook()
	priceFeed := realtime.NewPriceFeed(positionStore, priceBook)
	tradingService := trading.New()
	app := &App{
		Config:       cfg,
		Leagues:      leaguesFile.Leagues,
		GlobalParams: global,
		Accounts:     accountStore,
		Positions:    positionStore,
		PriceBook:    priceBook,
		Board:        board.NewService(leaguesFile.Leagues, cfg.HomeMarketsCachePath()),
		PriceFeed:    priceFeed,
		Trading:      tradingService,
		syncStatus:   map[string]any{},
	}
	app.Trading.SetDataAPITimeout(app.dataAPITimeout())
	app.PriceFeed.SetTimeouts(app.marketWsTimeouts())
	_ = app.Trading.SetProxy(app.proxyURL())
	_ = app.PriceFeed.SetProxy(app.proxyURL())
	app.Hub = realtime.NewHub(priceFeed)
	priceFeed.SetPublisher(app.Hub.BroadcastBoardTicks)
	priceFeed.SetTickHandler(app.handlePriceTicks)
	app.UserFeed = realtime.NewUserFeed(
		app.Accounts.Default,
		func() (time.Duration, time.Duration) {
			sec := 15
			if raw, ok := app.GlobalParams["userWsConnectTimeoutSec"]; ok {
				if n, ok := intFromAnyParam(raw); ok && n > 0 {
					sec = n
				}
			}
			return time.Duration(sec) * time.Second, time.Duration(sec/2) * time.Second
		},
		func(ctx context.Context) {
			if _, err := app.SyncChainPositions(ctx); err != nil {
				logrus.WithError(err).WithField("component", "chain_sync").Warn("chain sync after user websocket event failed")
			}
		},
	)
	_ = app.UserFeed.SetProxy(app.proxyURL())
	return app, nil
}

func defaultLeagues() []models.LeagueConfig {
	nbaIcon := "🏀"
	nhlIcon := "🏒"
	return []models.LeagueConfig{
		{Slug: "nba", Name: "NBA", Label: "NBA", SeriesID: 10345, TagID: 745, Icon: &nbaIcon},
		{Slug: "ncaab", Name: "NCAAB", Label: "NCAAB", TagID: 101952, Icon: &nbaIcon},
		{Slug: "nhl", Name: "NHL", Label: "NHL", TagID: 899, Icon: &nhlIcon},
	}
}

// Router returns the HTTP handler.
func (a *App) Router() http.Handler {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), requestLogger(), ginCors())

	r.GET("/health", a.health)
	r.GET("/api/runtime-status", a.runtimeStatus)
	r.GET("/api/settings/global-params", a.getGlobalParams)
	r.PUT("/api/settings/global-params", a.putGlobalParams)
	r.GET("/api/leagues", a.getLeagues)
	r.GET("/api/home/markets", a.getHomeMarkets)
	r.POST("/api/home/ticks", a.postHomeTicks)
	r.GET("/api/accounts", a.listAccounts)
	r.POST("/api/accounts", a.createAccount)
	r.DELETE("/api/accounts/:id", a.deleteAccount)
	r.POST("/api/accounts/:id/default", a.setDefaultAccount)
	r.POST("/orders", a.placeOrder)
	r.GET("/orders/:id", a.getOrder)
	r.POST("/trading/market-sell", a.marketSell)
	r.GET("/trading/order-book", a.getTradingOrderBook)
	r.POST("/trading/close-all", a.closeAllTrading)
	r.GET("/trading/orders", a.listTradingOrders)
	r.GET("/trading/trades", a.listTradingTrades)
	r.GET("/positions", a.listPositions)
	r.POST("/positions", a.registerPosition)
	r.POST("/positions/chain-sync", a.postChainSync)
	r.GET("/positions/chain-sync/status", a.getChainSyncStatus)
	r.PATCH("/positions/:id", a.patchPosition)
	r.POST("/positions/:id/arm", a.armPosition)
	r.POST("/positions/:id/disarm", a.disarmPosition)
	r.POST("/positions/:id/close", a.closePosition)
	r.PATCH("/risk/config", a.patchRiskConfig)
	r.GET("/monitor/snapshot", a.monitorSnapshot)
	r.GET("/monitor/close-tasks", a.closeTasks)
	r.POST("/monitor/start", a.ok)
	r.POST("/monitor/stop", a.ok)
	r.GET("/ws/board", a.wsBoard)
	r.GET("/ws/monitor", a.wsMonitor)

	r.NoRoute(a.staticFallback())
	return r
}

func ginCors() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key")
		c.Header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
		if c.Request.Method == http.MethodOptions {
			c.Status(http.StatusNoContent)
			c.Abort()
			return
		}
		c.Next()
	}
}

func requestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		entry := logrus.WithFields(logrus.Fields{
			"component":  "api",
			"method":     c.Request.Method,
			"path":       c.Request.URL.Path,
			"query":      c.Request.URL.RawQuery,
			"status":     c.Writer.Status(),
			"latency_ms": time.Since(start).Milliseconds(),
			"client_ip":  c.ClientIP(),
			"user_agent": c.Request.UserAgent(),
		})
		if len(c.Errors) > 0 {
			entry = entry.WithField("errors", c.Errors.String())
		}
		if c.Writer.Status() >= 500 {
			entry.Error("api request completed")
			return
		}
		if c.Writer.Status() >= 400 {
			entry.Warn("api request completed")
			return
		}
		entry.Info("api request completed")
	}
}

func (a *App) health(c *gin.Context) {
	c.JSON(http.StatusOK, map[string]any{
		"status":  "ok",
		"monitor": map[string]any{"running": true},
		"chainSync": map[string]any{
			"lastSyncAt": nil,
			"lastError":  nil,
		},
	})
}

func (a *App) runtimeStatus(c *gin.Context) {
	var lastTick any
	if t := a.PriceBook.LastTickAt(); t != nil {
		lastTick = t.Format(time.RFC3339Nano)
	}
	a.syncMu.RLock()
	syncStatus := copyMap(a.syncStatus)
	a.syncMu.RUnlock()
	c.JSON(http.StatusOK, map[string]any{
		"monitorWsRunning":        true,
		"lastChainSyncAt":         syncStatus["lastSyncAt"],
		"lastChainSyncError":      syncStatus["lastError"],
		"lastDataApiUser":         syncStatus["dataApiUser"],
		"lastChainPositionsCount": syncStatus["chainPositionsCount"],
		"openPositionsCount":      len(a.Positions.ListOpen()),
		"lastPriceTickAt":         lastTick,
	})
}

func (a *App) getGlobalParams(c *gin.Context) {
	c.JSON(http.StatusOK, a.GlobalParams)
}

func (a *App) putGlobalParams(c *gin.Context) {
	var body map[string]any
	if err := json.NewDecoder(c.Request.Body).Decode(&body); err != nil {
		logrus.WithError(err).WithField("component", "settings").Warn("global params decode failed")
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	a.GlobalParams = body
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	if err := storage.SaveJSONAtomic(ctx, a.Config.GlobalParamsPath(), body); err != nil {
		logrus.WithError(err).WithField("component", "settings").Error("global params save failed")
		c.String(http.StatusInternalServerError, err.Error())
		return
	}
	logrus.WithFields(logrus.Fields{
		"component": "settings",
		"path":      a.Config.GlobalParamsPath(),
	}).Info("global params saved")
	c.JSON(http.StatusOK, body)
}

func (a *App) getLeagues(c *gin.Context) {
	c.JSON(http.StatusOK, map[string]any{"leagues": a.Leagues})
}

func (a *App) getHomeMarkets(c *gin.Context) {
	q := c.Request.URL.Query()
	league := q.Get("league")
	if league == "" {
		league = "NBA"
	}
	status := q.Get("status")
	if status == "" {
		status = "active"
	}
	tz, _ := strconv.Atoi(q.Get("tz_offset"))
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	forceRefresh := queryBoolTrue(q, "refresh")
	logrus.WithFields(logrus.Fields{
		"component":     "basketball",
		"league":        league,
		"date":          q.Get("date"),
		"status":        status,
		"tz_offset":     tz,
		"force_refresh": forceRefresh,
	}).Info("home markets request started")
	cacheTTL := a.homeMarketsCacheTTL()
	result := a.Board.CachedHomeMarkets(ctx, league, q.Get("date"), status, tz, forceRefresh, cacheTTL)
	if result.Error != nil {
		logrus.WithField("error", *result.Error).WithFields(logrus.Fields{
			"component": "basketball",
			"league":    league,
			"cached":    result.Cached,
			"stale":     result.Stale,
		}).Warn("home markets request used cached fallback after refresh failure")
	}
	logrus.WithFields(logrus.Fields{
		"component": "basketball",
		"league":    league,
		"count":     len(result.Rows),
		"cached":    result.Cached,
		"stale":     result.Stale,
	}).Info("home markets request completed")
	c.JSON(http.StatusOK, homeMarketsResponse(result))
}

func homeMarketsResponse(result board.HomeMarketsResult) map[string]any {
	out := map[string]any{
		"success": true,
		"data": map[string]any{
			"markets": result.Rows,
		},
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
		"cached":    result.Cached,
		"stale":     result.Stale,
	}
	if result.UpdatedAt != nil {
		out["cacheUpdatedAt"] = *result.UpdatedAt
	}
	if result.Error != nil {
		out["warning"] = *result.Error
	}
	return out
}

func (a *App) postHomeTicks(c *gin.Context) {
	var body struct {
		TokenIDs []string `json:"tokenIds"`
	}
	if err := json.NewDecoder(c.Request.Body).Decode(&body); err != nil {
		logrus.WithError(err).WithField("component", "quotes").Warn("home ticks decode failed")
		c.String(http.StatusBadRequest, err.Error())
		return
	}
	logrus.WithFields(logrus.Fields{
		"component":   "quotes",
		"token_count": len(body.TokenIDs),
	}).Info("home ticks requested")
	quotes := map[string]any{}
	c.JSON(http.StatusOK, map[string]any{"quotes": quotes})
}

func (a *App) listAccounts(c *gin.Context) {
	defaultID, records := a.Accounts.Snapshot()
	logrus.WithFields(logrus.Fields{
		"component":  "accounts",
		"count":      len(records),
		"default_id": defaultID,
	}).Info("accounts listed")
	views := make([]models.AccountView, 0, len(records))
	for _, rec := range records {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
		bal, note, err := a.Trading.BalanceUSDC(ctx, rec)
		if err != nil {
			note = "CLOB unavailable"
			logrus.WithError(err).WithFields(logrus.Fields{
				"component":  "accounts",
				"account_id": rec.ID,
			}).Warn("account balance fetch failed")
		}
		port, err := a.Trading.PortfolioValue(ctx, rec)
		if err != nil {
			logrus.WithError(err).WithFields(logrus.Fields{
				"component":  "accounts",
				"account_id": rec.ID,
			}).Warn("portfolio value fetch failed")
		}
		cancel()
		views = append(views, accounts.View(rec, defaultID, bal, port, note))
	}
	c.JSON(http.StatusOK, map[string]any{
		"defaultId": defaultID,
		"accounts":  views,
	})
}

func (a *App) createAccount(c *gin.Context) {
	var req models.CreateAccountRequest
	if err := json.NewDecoder(c.Request.Body).Decode(&req); err != nil {
		logrus.WithError(err).WithField("component", "accounts").Warn("create account decode failed")
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), accounts.CreateAccountRequestTimeout())
	defer cancel()
	logrus.WithFields(logrus.Fields{
		"component": "accounts",
		"label":     labelValue(req.Label),
	}).Info("create account requested")
	rec, err := accounts.DeriveAccountRecordWithCLOB(ctx, req.Label, req.EVMPrivateKey, a.proxyURL())
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "accounts",
			"label":     labelValue(req.Label),
		}).Warn("create account derive failed")
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	saved, err := a.Accounts.Add(ctx, rec)
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": rec.ID,
		}).Warn("create account save failed")
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if saved.ProxyWalletAddress == saved.EOAAddress {
		logrus.WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": saved.ID,
		}).Warn("proxy wallet equals EOA; positions may be empty until Safe proxy is available")
	}
	defaultID, _ := a.Accounts.Snapshot()
	bal, note, _ := a.Trading.BalanceUSDC(ctx, saved)
	port, _ := a.Trading.PortfolioValue(ctx, saved)
	logrus.WithFields(logrus.Fields{
		"component":      "accounts",
		"account_id":     saved.ID,
		"eoa_address":    saved.EOAAddress,
		"proxy_address":  saved.ProxyWalletAddress,
		"has_clob_creds": saved.HasCLOBCredentials(),
	}).Info("create account completed")
	c.JSON(http.StatusOK, accounts.View(saved, defaultID, bal, port, note))
}

func (a *App) deleteAccount(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	id := c.Param("id")
	if err := a.Accounts.Delete(ctx, id); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": id,
		}).Warn("account delete failed")
		c.String(http.StatusNotFound, err.Error())
		return
	}
	logrus.WithFields(logrus.Fields{
		"component":  "accounts",
		"account_id": id,
	}).Info("account deleted")
	c.JSON(http.StatusOK, map[string]any{"ok": true})
}

func (a *App) setDefaultAccount(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	id := c.Param("id")
	if err := a.Accounts.SetDefault(ctx, id); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": id,
		}).Warn("set default account failed")
		c.String(http.StatusNotFound, err.Error())
		return
	}
	logrus.WithFields(logrus.Fields{
		"component":  "accounts",
		"account_id": id,
	}).Info("default account changed")
	c.JSON(http.StatusOK, map[string]any{"ok": true})
}

func labelValue(label *string) string {
	if label == nil {
		return ""
	}
	return *label
}

func (a *App) defaultAccountOrError(c *gin.Context) (models.AccountRecord, bool) {
	acc, ok := a.Accounts.Default()
	if !ok {
		c.JSON(http.StatusBadRequest, map[string]any{"error": "no default account"})
		return models.AccountRecord{}, false
	}
	return acc, true
}

func (a *App) placeOrder(c *gin.Context) {
	var req models.PlaceOrderRequest
	if err := json.NewDecoder(c.Request.Body).Decode(&req); err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	acc, ok := a.defaultAccountOrError(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
	defer cancel()
	resp, err := a.Trading.PlaceOrder(ctx, acc, req, c.GetHeader("Idempotency-Key"))
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{"component": "orders", "token_id": req.TokenID}).Warn("place order failed")
		c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (a *App) getOrder(c *gin.Context) {
	acc, ok := a.defaultAccountOrError(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	body, err := a.Trading.ListOrders(ctx, acc)
	if err != nil {
		c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	id := c.Param("id")
	if rows, _ := body["data"].([]map[string]any); len(rows) > 0 {
		for _, row := range rows {
			if row["id"] == id || row["orderID"] == id || row["orderID"] == c.Param("id") {
				c.JSON(http.StatusOK, row)
				return
			}
		}
	}
	c.JSON(http.StatusNotFound, map[string]any{"error": "order not found"})
}

func (a *App) getTradingOrderBook(c *gin.Context) {
	tokenID := strings.TrimSpace(c.Query("token_id"))
	if tokenID == "" {
		c.JSON(http.StatusBadRequest, map[string]any{"error": "token_id is required"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	summary, err := a.Trading.OrderBookSummary(ctx, tokenID)
	if err != nil {
		c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, summary)
}

func (a *App) marketSell(c *gin.Context) {
	var req models.MarketSellRequest
	if err := json.NewDecoder(c.Request.Body).Decode(&req); err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	acc, ok := a.defaultAccountOrError(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
	defer cancel()
	resp, err := a.Trading.MarketSellShares(ctx, acc, req.TokenID, req.Shares, req.DryRun)
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{"component": "orders", "token_id": req.TokenID}).Warn("market sell failed")
		c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

func (a *App) closeAllTrading(c *gin.Context) {
	var req models.CloseAllTradingRequest
	if c.Request.Body != nil {
		_ = json.NewDecoder(c.Request.Body).Decode(&req)
	}
	acc, ok := a.defaultAccountOrError(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()
	cancelResp, err := a.Trading.CancelAllOrders(ctx, acc)
	if err != nil {
		c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	results := make([]map[string]any, 0, len(req.Sells))
	for _, leg := range req.Sells {
		resp, sellErr := a.Trading.MarketSellShares(ctx, acc, leg.TokenID, leg.Shares, false)
		row := map[string]any{"tokenId": leg.TokenID}
		if sellErr != nil {
			row["error"] = sellErr.Error()
		} else {
			row["order"] = resp
		}
		results = append(results, row)
	}
	c.JSON(http.StatusOK, map[string]any{"cancel": cancelResp, "results": results})
}

func (a *App) listTradingOrders(c *gin.Context) {
	acc, ok := a.defaultAccountOrError(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	body, err := a.Trading.ListOrders(ctx, acc)
	if err != nil {
		c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, body)
}

func (a *App) listTradingTrades(c *gin.Context) {
	acc, ok := a.defaultAccountOrError(c)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	body, err := a.Trading.ListTrades(ctx, acc)
	if err != nil {
		c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, body)
}

func (a *App) listPositions(c *gin.Context) {
	rows := a.Positions.ListAll()
	if raw := c.Request.URL.Query().Get("paper"); raw != "" {
		want := raw == "true"
		filtered := rows[:0]
		for _, row := range rows {
			if row.Paper == want {
				filtered = append(filtered, row)
			}
		}
		rows = filtered
	}
	logrus.WithFields(logrus.Fields{
		"component": "positions",
		"count":     len(rows),
		"paper":     c.Request.URL.Query().Get("paper"),
	}).Info("positions listed")
	c.JSON(http.StatusOK, rows)
}

func (a *App) registerPosition(c *gin.Context) {
	var req models.RegisterPositionRequest
	if err := json.NewDecoder(c.Request.Body).Decode(&req); err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	p, err := a.Positions.Register(ctx, req)
	if err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	a.PriceFeed.SetBoardTokens(a.PriceFeed.DesiredTokens())
	c.JSON(http.StatusOK, p)
}

func (a *App) postChainSync(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), a.dataAPITimeout()+15*time.Second)
	defer cancel()
	res, err := a.SyncChainPositions(ctx)
	if err != nil {
		c.JSON(http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

func (a *App) getChainSyncStatus(c *gin.Context) {
	a.syncMu.RLock()
	status := copyMap(a.syncStatus)
	a.syncMu.RUnlock()
	status["externalOpenCount"] = countExternalOpen(a.Positions.ListAll())
	c.JSON(http.StatusOK, status)
}

func (a *App) patchPosition(c *gin.Context) {
	var body struct {
		StopTrailPct     *float64 `json:"stopTrailPct"`
		MonitoringActive *bool    `json:"monitoringActive"`
	}
	if err := json.NewDecoder(c.Request.Body).Decode(&body); err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	p, ok, err := a.Positions.Update(ctx, c.Param("id"), func(pos *models.Position) {
		if body.StopTrailPct != nil {
			pos.StopTrailPct = *body.StopTrailPct
		}
		if body.MonitoringActive != nil {
			pos.MonitoringActive = *body.MonitoringActive
		}
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		c.JSON(http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, p)
}

func (a *App) armPosition(c *gin.Context) {
	a.setPositionMonitoring(c, true)
}

func (a *App) disarmPosition(c *gin.Context) {
	a.setPositionMonitoring(c, false)
}

func (a *App) setPositionMonitoring(c *gin.Context, active bool) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	p, ok, err := a.Positions.Update(ctx, c.Param("id"), func(pos *models.Position) {
		pos.MonitoringActive = active
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if !ok {
		c.JSON(http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, p)
}

func (a *App) closePosition(c *gin.Context) {
	p, ok := a.Positions.Get(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 45*time.Second)
	defer cancel()
	if p.State == "open" && p.Shares > 0 && p.TokenID != "" && !p.Paper {
		acc, ok := a.defaultAccountOrError(c)
		if !ok {
			return
		}
		if _, err := a.Trading.MarketSellShares(ctx, acc, p.TokenID, p.Shares, false); err != nil {
			c.JSON(http.StatusBadGateway, map[string]any{"error": "sell failed: " + err.Error()})
			return
		}
	}
	_, _, err := a.Positions.Update(ctx, p.ID, func(pos *models.Position) {
		pos.State = "manual_closed"
		pos.MonitoringActive = false
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, map[string]any{"ok": true})
}

func (a *App) patchRiskConfig(c *gin.Context) {
	var body struct {
		DefaultStopTrailPct *float64 `json:"defaultStopTrailPct"`
		MinTickDebounceMs   *int     `json:"minTickDebounceMs"`
	}
	if err := json.NewDecoder(c.Request.Body).Decode(&body); err != nil {
		c.JSON(http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	cfg, err := a.Positions.SetRisk(ctx, body.DefaultStopTrailPct, body.MinTickDebounceMs)
	if err != nil {
		c.JSON(http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cfg)
}

func (a *App) monitorSnapshot(c *gin.Context) {
	positions := a.Positions.ListAll()
	logrus.WithFields(logrus.Fields{
		"component":      "positions",
		"position_count": len(positions),
	}).Info("monitor snapshot requested")
	c.JSON(http.StatusOK, a.PriceBook.BuildSnapshot(positions, a.Positions.Risk()))
}

func (a *App) closeTasks(c *gin.Context) {
	tasks := a.Positions.ListCloseTasks()
	logrus.WithFields(logrus.Fields{
		"component":  "stop_loss",
		"task_count": len(tasks),
	}).Info("close tasks listed")
	c.JSON(http.StatusOK, map[string]any{"tasks": tasks})
}

func (a *App) ok(c *gin.Context) {
	logrus.WithFields(logrus.Fields{
		"component": "monitor",
		"path":      c.Request.URL.Path,
	}).Info("monitor command accepted")
	c.JSON(http.StatusOK, map[string]any{"ok": true})
}

func (a *App) wsBoard(c *gin.Context) {
	logrus.WithFields(logrus.Fields{
		"component": "websocket",
		"channel":   "board",
		"client_ip": c.ClientIP(),
	}).Info("board websocket upgrade requested")
	a.Hub.ServeBoard(c.Writer, c.Request)
}

func (a *App) wsMonitor(c *gin.Context) {
	logrus.WithFields(logrus.Fields{
		"component": "websocket",
		"channel":   "monitor",
		"client_ip": c.ClientIP(),
	}).Info("monitor websocket upgrade requested")
	a.Hub.ServeMonitor(c.Writer, c.Request, a.PriceBook.BuildSnapshot(a.Positions.ListAll(), a.Positions.Risk()))
}

func (a *App) handlePriceTicks(_ []risk.Tick) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	a.processCloseQueue(ctx)
	a.evaluateTrailingStops(ctx)
	if a.Hub != nil {
		a.Hub.BroadcastMonitor(a.PriceBook.BuildSnapshot(a.Positions.ListAll(), a.Positions.Risk()))
	}
}

// RunCloseQueue retries failed stop-loss closes even when no fresh market tick arrives.
func (a *App) RunCloseQueue(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
			changed := a.processCloseQueue(runCtx)
			cancel()
			if changed && a.Hub != nil {
				a.Hub.BroadcastMonitor(a.PriceBook.BuildSnapshot(a.Positions.ListAll(), a.Positions.Risk()))
			}
		}
	}
}

// RunUserFeed keeps the authenticated user websocket connected.
func (a *App) RunUserFeed(ctx context.Context) {
	if a.UserFeed != nil {
		a.UserFeed.Run(ctx)
	}
}

// RunChainSync periodically reconciles Data API positions even if the user websocket is quiet.
func (a *App) RunChainSync(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runCtx, cancel := context.WithTimeout(ctx, a.dataAPITimeout()+15*time.Second)
			if _, err := a.SyncChainPositions(runCtx); err != nil {
				logrus.WithError(err).WithField("component", "chain_sync").Warn("periodic chain sync failed")
			}
			cancel()
		}
	}
}

// RunHomeMarketsRefresh keeps cached event metadata warm without blocking the UI.
func (a *App) RunHomeMarketsRefresh(ctx context.Context) {
	ticker := time.NewTicker(3 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
			a.Board.RefreshStaleHomeMarkets(runCtx, a.homeMarketsCacheTTL())
			cancel()
		}
	}
}

// SyncChainPositions pulls current Data API positions into the local monitor store.
func (a *App) SyncChainPositions(ctx context.Context) (map[string]any, error) {
	acc, ok := a.Accounts.Default()
	if !ok {
		res := map[string]any{"ok": true, "syncedCount": 0, "createdCount": 0, "updatedCount": 0, "closedCount": 0}
		a.recordSyncStatus(res, "", nil)
		return res, nil
	}
	res, err := a.Trading.SyncPositionsFromDataAPI(ctx, acc, a.Positions, a.defaultStopTrailPct(), a.stopLossTiers())
	if err != nil {
		a.recordSyncStatus(nil, dataAPIUser(acc), err)
		return nil, err
	}
	out := map[string]any{
		"ok":           true,
		"syncedCount":  res["syncedCount"],
		"createdCount": res["createdCount"],
		"updatedCount": res["updatedCount"],
		"closedCount":  res["closedCount"],
	}
	a.recordSyncStatus(out, dataAPIUser(acc), nil)
	if n, _ := out["syncedCount"].(int); n > 0 && a.Hub != nil {
		a.Hub.BroadcastMonitor(a.PriceBook.BuildSnapshot(a.Positions.ListAll(), a.Positions.Risk()))
	}
	return out, nil
}

func (a *App) recordSyncStatus(res map[string]any, user string, err error) {
	a.syncMu.Lock()
	defer a.syncMu.Unlock()
	if a.syncStatus == nil {
		a.syncStatus = map[string]any{}
	}
	a.syncStatus["lastSyncAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	a.syncStatus["dataApiUser"] = user
	a.syncStatus["chainPositionsCount"] = len(a.Positions.ListOpen())
	if err != nil {
		a.syncStatus["lastError"] = err.Error()
		return
	}
	a.syncStatus["lastError"] = nil
	for k, v := range res {
		a.syncStatus[k] = v
	}
}

func (a *App) defaultStopTrailPct() float64 {
	if raw, ok := a.GlobalParams["externalDefaultStopLossPct"]; ok {
		if v, ok := raw.(float64); ok && v > 0 {
			return v / 100
		}
	}
	if raw, ok := a.GlobalParams["external_default_stop_loss_pct"]; ok {
		if v, ok := raw.(float64); ok && v > 0 {
			return v / 100
		}
	}
	return a.Positions.Risk().DefaultStopTrailPct
}

func (a *App) stopLossTiers() []models.TierConfig {
	raw, ok := a.GlobalParams["tiers"]
	if !ok {
		return nil
	}
	rows, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]models.TierConfig, 0, len(rows))
	for _, row := range rows {
		m, ok := row.(map[string]any)
		if !ok {
			continue
		}
		min, okMin := floatFromMap(m, "min")
		max, okMax := floatFromMap(m, "max")
		stop, okStop := floatFromMap(m, "defaultStopLoss")
		if !okMin || !okMax || !okStop || min < 0 || max <= min || stop <= 0 {
			continue
		}
		out = append(out, models.TierConfig{
			ID:              stringFromMap(m, "id"),
			Label:           stringFromMap(m, "label"),
			Min:             min,
			Max:             max,
			AllocPct:        floatFromMapDefault(m, "allocPct", 0),
			DefaultStopLoss: stop,
		})
	}
	return out
}

// nonRetryableMarketSellErr: order parameters will not become valid by retrying (CLOB 400 class).
func nonRetryableMarketSellErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "below clob min_order_size") ||
		strings.Contains(msg, "likely below clob minimum") ||
		strings.Contains(msg, "shares invalid after lot-size") ||
		strings.Contains(msg, "invalid_order_min_size") ||
		strings.Contains(msg, "min size") ||
		strings.Contains(msg, "order min size")
}

func (a *App) evaluateTrailingStops(ctx context.Context) bool {
	acc, ok := a.Accounts.Default()
	if !ok {
		return false
	}
	changed := false
	for _, pos := range a.Positions.ListOpen() {
		if !pos.MonitoringActive || pos.TokenID == "" {
			continue
		}
		tick, ok := a.PriceBook.Get(pos.TokenID)
		if !ok || tick.Mid <= 0 {
			continue
		}
		if tick.Mid > pos.HighWaterMark || pos.HighWaterMark <= 0 {
			_, _, err := a.Positions.Update(ctx, pos.ID, func(p *models.Position) {
				p.HighWaterMark = tick.Mid
			})
			if err == nil {
				changed = true
			}
		}
		ref, ok := a.Positions.Get(pos.ID)
		if !ok || tick.Bid <= 0 {
			continue
		}
		stopPrice := ref.HighWaterMark * (1 - ref.StopTrailPct)
		if stopPrice <= 0 || tick.Bid > stopPrice {
			continue
		}
		if a.Positions.HasPendingCloseTask(ref.ID, "trail_stop") {
			continue
		}
		logrus.WithFields(logrus.Fields{
			"component":       "stop_loss",
			"position_id":     ref.ID,
			"token_id":        ref.TokenID,
			"bid":             tick.Bid,
			"high_water_mark": ref.HighWaterMark,
			"stop_price":      stopPrice,
		}).Warn("trailing stop triggered")
		if ref.Paper {
			_, _, _ = a.Positions.Update(ctx, ref.ID, func(p *models.Position) {
				p.State = "stopped_out"
				p.MonitoringActive = false
			})
			changed = true
			continue
		}
		if _, err := a.Trading.MarketSellShares(ctx, acc, ref.TokenID, ref.Shares, false); err != nil {
			if nonRetryableMarketSellErr(err) {
				_ = a.Positions.RemoveCloseTask(ctx, ref.ID, "trail_stop")
				_, _, _ = a.Positions.Update(ctx, ref.ID, func(p *models.Position) {
					p.MonitoringActive = false
				})
				logrus.WithError(err).WithFields(logrus.Fields{
					"component":   "stop_loss",
					"position_id": ref.ID,
					"token_id":    ref.TokenID,
				}).Warn("trail stop sell aborted (non-retryable); monitoring disabled — fix size/liquidity or close on polymarket.com")
			} else {
				_ = a.Positions.RecordCloseFailure(ctx, ref.ID, "trail_stop", err.Error())
			}
			changed = true
			continue
		}
		_, _, _ = a.Positions.Update(ctx, ref.ID, func(p *models.Position) {
			p.State = "stopped_out"
			p.MonitoringActive = false
		})
		_ = a.Positions.RemoveCloseTask(ctx, ref.ID, "trail_stop")
		changed = true
	}
	return changed
}

func (a *App) processCloseQueue(ctx context.Context) bool {
	acc, ok := a.Accounts.Default()
	if !ok {
		return false
	}
	changed := false
	for _, task := range a.Positions.ListCloseTasksReady(time.Now().UTC()) {
		pos, ok := a.Positions.Get(task.PositionID)
		if !ok || pos.State != "open" || task.Kind != "trail_stop" {
			_ = a.Positions.RemoveCloseTask(ctx, task.PositionID, task.Kind)
			changed = true
			continue
		}
		if pos.Paper {
			_, _, _ = a.Positions.Update(ctx, pos.ID, func(p *models.Position) {
				p.State = "stopped_out"
				p.MonitoringActive = false
			})
			_ = a.Positions.RemoveCloseTask(ctx, task.PositionID, task.Kind)
			changed = true
			continue
		}
		if _, err := a.Trading.MarketSellShares(ctx, acc, pos.TokenID, pos.Shares, false); err != nil {
			if nonRetryableMarketSellErr(err) {
				_ = a.Positions.RemoveCloseTask(ctx, task.PositionID, task.Kind)
				_, _, _ = a.Positions.Update(ctx, pos.ID, func(p *models.Position) {
					p.MonitoringActive = false
				})
				logrus.WithError(err).WithFields(logrus.Fields{
					"component":   "stop_loss",
					"position_id": pos.ID,
					"token_id":    pos.TokenID,
				}).Warn("close queue sell aborted (non-retryable); monitoring disabled")
			} else {
				_ = a.Positions.RecordCloseFailure(ctx, pos.ID, task.Kind, err.Error())
			}
			changed = true
			continue
		}
		_, _, _ = a.Positions.Update(ctx, pos.ID, func(p *models.Position) {
			p.State = "stopped_out"
			p.MonitoringActive = false
		})
		_ = a.Positions.RemoveCloseTask(ctx, task.PositionID, task.Kind)
		changed = true
	}
	return changed
}

func dataAPIUser(acc models.AccountRecord) string {
	if acc.ProxyWalletAddress != "" {
		return acc.ProxyWalletAddress
	}
	return acc.EOAAddress
}

func floatFromMap(m map[string]any, key string) (float64, bool) {
	switch v := m[key].(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case json.Number:
		n, err := v.Float64()
		return n, err == nil
	case string:
		n, err := strconv.ParseFloat(v, 64)
		return n, err == nil
	default:
		return 0, false
	}
}

func floatFromMapDefault(m map[string]any, key string, fallback float64) float64 {
	if v, ok := floatFromMap(m, key); ok {
		return v
	}
	return fallback
}

func stringFromMap(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func copyMap(src map[string]any) map[string]any {
	out := make(map[string]any, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

func queryBoolTrue(q url.Values, key string) bool {
	v := strings.TrimSpace(strings.ToLower(q.Get(key)))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func (a *App) homeMarketsCacheTTL() time.Duration {
	const minSec = 30
	const maxSec = 7200
	sec := 180
	for _, key := range []string{"homeMarketsCacheTtlSec", "home_markets_cache_ttl_sec"} {
		if v, ok := a.GlobalParams[key]; ok {
			if n, ok := intFromAnyParam(v); ok {
				sec = n
				break
			}
		}
	}
	if sec < minSec {
		sec = minSec
	}
	if sec > maxSec {
		sec = maxSec
	}
	return time.Duration(sec) * time.Second
}

func (a *App) dataAPITimeout() time.Duration {
	const minSec = 10
	const maxSec = 120
	sec := 30
	for _, key := range []string{"dataApiTimeoutSec", "data_api_timeout_sec"} {
		if v, ok := a.GlobalParams[key]; ok {
			if n, ok := intFromAnyParam(v); ok {
				sec = n
				break
			}
		}
	}
	if sec < minSec {
		sec = minSec
	}
	if sec > maxSec {
		sec = maxSec
	}
	return time.Duration(sec) * time.Second
}

func (a *App) marketWsTimeouts() (time.Duration, time.Duration) {
	const minSec = 5
	const maxSec = 60
	sec := 15
	for _, key := range []string{"marketWsConnectTimeoutSec", "market_ws_connect_timeout_sec"} {
		if v, ok := a.GlobalParams[key]; ok {
			if n, ok := intFromAnyParam(v); ok {
				sec = n
				break
			}
		}
	}
	if sec < minSec {
		sec = minSec
	}
	if sec > maxSec {
		sec = maxSec
	}
	conn := time.Duration(sec) * time.Second
	return conn, conn / 2
}

func (a *App) proxyURL() string {
	for _, key := range []string{"proxyUrl", "proxy_url"} {
		if v, ok := a.GlobalParams[key]; ok {
			if s, ok := v.(string); ok {
				return strings.TrimSpace(s)
			}
		}
	}
	return ""
}

func intFromAnyParam(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case int32:
		return int(x), true
	case int64:
		return int(x), true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		return n, err == nil
	default:
		return 0, false
	}
}

func countExternalOpen(rows []models.Position) int {
	n := 0
	for _, row := range rows {
		if row.External && row.State == "open" {
			n++
		}
	}
	return n
}

func (a *App) staticFallback() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := filepath.Join(a.Config.WebDir, filepath.Clean(c.Request.URL.Path))
		if st, err := os.Stat(path); err == nil && !st.IsDir() {
			http.ServeFile(c.Writer, c.Request, path)
			return
		}
		index := filepath.Join(a.Config.WebDir, "index.html")
		if _, err := os.Stat(index); err == nil {
			http.ServeFile(c.Writer, c.Request, index)
			return
		}
		c.Status(http.StatusNotFound)
	}
}
