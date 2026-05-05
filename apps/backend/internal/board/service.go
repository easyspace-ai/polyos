package board

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/drinkthere/polyserver/internal/models"
	"github.com/drinkthere/polyserver/internal/storage"
	"github.com/sirupsen/logrus"
)

const nbaDefaultSeriesID int64 = 10345
const espnNBAScoreboard = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"

// defaultHomeMarketsCacheTTL used when request does not supply a TTL (should not happen via HTTP).
const defaultHomeMarketsCacheTTL = 3 * time.Minute

// listingHorizonDays: keep events whose start falls within roughly the next week (Polymarket sports hub).
const listingHorizonDays = 7

// Service provides basketball market discovery following the Rust backend strategy.
type Service struct {
	httpClient *http.Client
	leagues    []models.LeagueConfig
	cachePath  string
	cacheMu    sync.Mutex
	cache      homeMarketsCacheFile
	keyLocks   map[string]*sync.Mutex
	failures   map[string]time.Time
}

// NewService creates a board service.
func NewService(leagues []models.LeagueConfig, cachePath string) *Service {
	s := &Service{
		httpClient: &http.Client{Timeout: 12 * time.Second},
		leagues:    leagues,
		cachePath: cachePath,
		keyLocks:  map[string]*sync.Mutex{},
		failures:   map[string]time.Time{},
	}
	s.loadCache(context.Background())
	return s
}

// HomeMarketsResult contains rows plus cache metadata for API responses.
type HomeMarketsResult struct {
	Rows      []models.HomeMarketItem
	Cached    bool
	Stale     bool
	UpdatedAt *string
	Error     *string
}

type homeMarketsCacheFile struct {
	Schema  string                         `json:"schema"`
	Entries map[string]homeMarketsCacheRow `json:"entries"`
}

type homeMarketsCacheRow struct {
	Rows      []models.HomeMarketItem `json:"rows"`
	UpdatedAt string                  `json:"updatedAt"`
}

// HomeMarkets fetches home markets. NBA follows Rust's series-first strategy, with Gamma fallback planned.
func (s *Service) HomeMarkets(ctx context.Context, league, date, status string, tzOffset int) ([]models.HomeMarketItem, error) {
	cfg, ok := findLeague(s.leagues, strings.ToLower(league))
	if !ok {
		logrus.WithFields(logrus.Fields{
			"component": "basketball",
			"league":    league,
		}).Warn("league config not found")
		return []models.HomeMarketItem{}, nil
	}
	logrus.WithFields(logrus.Fields{
		"component": "basketball",
		"league":    league,
		"slug":      cfg.Slug,
		"tag_id":    cfg.TagID,
		"series_id": cfg.SeriesID,
		"date":      date,
		"status":    status,
		"tz_offset": tzOffset,
	}).Info("home markets fetch started")
	if strings.EqualFold(cfg.Slug, "nba") || strings.EqualFold(league, "nba") {
		return s.nbaHomeMarkets(ctx, cfg, date, status, tzOffset)
	}
	return s.gammaMoneylineHomeMarkets(ctx, cfg, date, status, tzOffset)
}

// CachedHomeMarkets returns fresh-enough rows: TTL-fresh cache is served as-is; stale or forceRefresh triggers a synchronous upstream refresh so callers do not keep reading a partial list while a background job catches up.
func (s *Service) CachedHomeMarkets(ctx context.Context, league, date, status string, tzOffset int, forceRefresh bool, cacheTTL time.Duration) HomeMarketsResult {
	ttl := effectiveCacheTTL(cacheTTL)
	key := cacheKey(league, date, status, tzOffset)
	if forceRefresh {
		rows, err := s.refreshCache(ctx, key, league, date, status, tzOffset, true, ttl)
		if err != nil {
			msg := err.Error()
			if row, ok := s.getCache(key); ok {
				return HomeMarketsResult{Rows: row.Rows, Cached: true, Stale: true, UpdatedAt: &row.UpdatedAt, Error: &msg}
			}
			return HomeMarketsResult{Rows: []models.HomeMarketItem{}, Cached: true, Stale: true, Error: &msg}
		}
		return HomeMarketsResult{Rows: rows, Cached: false, Stale: false}
	}
	if row, ok := s.getCache(key); ok {
		stale := cacheRowStale(row, ttl)
		if !stale {
			return HomeMarketsResult{
				Rows:      row.Rows,
				Cached:    true,
				Stale:     false,
				UpdatedAt: &row.UpdatedAt,
			}
		}
		rows, err := s.refreshCache(ctx, key, league, date, status, tzOffset, false, ttl)
		if err != nil {
			msg := err.Error()
			return HomeMarketsResult{Rows: row.Rows, Cached: true, Stale: true, UpdatedAt: &row.UpdatedAt, Error: &msg}
		}
		return HomeMarketsResult{Rows: rows, Cached: false, Stale: false}
	}
	rows, err := s.refreshCache(ctx, key, league, date, status, tzOffset, false, ttl)
	if err != nil {
		msg := err.Error()
		if row, ok := s.getCache(key); ok {
			return HomeMarketsResult{Rows: row.Rows, Cached: true, Stale: true, UpdatedAt: &row.UpdatedAt, Error: &msg}
		}
		return HomeMarketsResult{Rows: []models.HomeMarketItem{}, Cached: true, Stale: true, Error: &msg}
	}
	return HomeMarketsResult{Rows: rows, Cached: false, Stale: false}
}

// RefreshStaleHomeMarkets refreshes all known cache entries whose TTL has expired.
func (s *Service) RefreshStaleHomeMarkets(ctx context.Context, cacheTTL time.Duration) {
	ttl := effectiveCacheTTL(cacheTTL)
	keys := s.staleCacheKeys(ttl)
	for _, key := range keys {
		league, date, status, tzOffset, ok := parseCacheKey(key)
		if !ok {
			continue
		}
		if _, err := s.refreshCache(ctx, key, league, date, status, tzOffset, false, ttl); err != nil {
			logrus.WithError(err).WithFields(logrus.Fields{
				"component": "basketball_cache",
				"key":       key,
				"league":    league,
			}).Warn("scheduled home markets refresh failed")
		}
	}
}

func effectiveCacheTTL(d time.Duration) time.Duration {
	if d <= 0 {
		return defaultHomeMarketsCacheTTL
	}
	return d
}

func (s *Service) refreshCache(ctx context.Context, key, league, date, status string, tzOffset int, force bool, cacheTTL time.Duration) ([]models.HomeMarketItem, error) {
	ttl := effectiveCacheTTL(cacheTTL)
	lock := s.keyLock(key)
	lock.Lock()
	defer lock.Unlock()
	if !force {
		if row, ok := s.getCache(key); ok && !cacheRowStale(row, ttl) {
			return row.Rows, nil
		}
	}
	if until, ok := s.failureUntil(key); ok && time.Now().Before(until) {
		return nil, fmt.Errorf("recent home markets refresh failed; retry after %s", until.Format(time.RFC3339))
	}
	rows, err := s.HomeMarkets(ctx, league, date, status, tzOffset)
	if err != nil {
		s.recordFailure(key, 45*time.Second)
		return nil, err
	}
	s.clearFailure(key)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	s.cacheMu.Lock()
	if s.cache.Entries == nil {
		s.cache = homeMarketsCacheFile{Schema: "home-markets-cache-v1", Entries: map[string]homeMarketsCacheRow{}}
	}
	s.cache.Entries[key] = homeMarketsCacheRow{Rows: rows, UpdatedAt: now}
	cache := s.cache
	s.cacheMu.Unlock()
	if err := storage.SaveJSONAtomic(ctx, s.cachePath, cache); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "basketball_cache",
			"path":      s.cachePath,
			"key":       key,
		}).Warn("home markets cache save failed")
	}
	logrus.WithFields(logrus.Fields{
		"component": "basketball_cache",
		"key":       key,
		"league":    league,
		"count":     len(rows),
	}).Info("home markets cache refreshed")
	return rows, nil
}

func (s *Service) keyLock(key string) *sync.Mutex {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	lock, ok := s.keyLocks[key]
	if ok {
		return lock
	}
	lock = &sync.Mutex{}
	s.keyLocks[key] = lock
	return lock
}

func (s *Service) failureUntil(key string) (time.Time, bool) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	until, ok := s.failures[key]
	return until, ok
}

func (s *Service) recordFailure(key string, ttl time.Duration) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	s.failures[key] = time.Now().Add(ttl)
}

func (s *Service) clearFailure(key string) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	delete(s.failures, key)
}

func (s *Service) loadCache(ctx context.Context) {
	if strings.TrimSpace(s.cachePath) == "" {
		return
	}
	var file homeMarketsCacheFile
	if err := storage.LoadJSON(ctx, s.cachePath, &file); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			logrus.WithError(err).WithFields(logrus.Fields{
				"component": "basketball_cache",
				"path":      s.cachePath,
			}).Warn("home markets cache load failed")
		}
	}
	if file.Entries == nil {
		file = homeMarketsCacheFile{Schema: "home-markets-cache-v1", Entries: map[string]homeMarketsCacheRow{}}
	}
	s.cacheMu.Lock()
	s.cache = file
	s.cacheMu.Unlock()
	logrus.WithFields(logrus.Fields{
		"component": "basketball_cache",
		"path":      s.cachePath,
		"entries":   len(file.Entries),
	}).Info("home markets cache loaded")
}

func (s *Service) getCache(key string) (homeMarketsCacheRow, bool) {
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	row, ok := s.cache.Entries[key]
	return row, ok
}

func (s *Service) staleCacheKeys(cacheTTL time.Duration) []string {
	ttl := effectiveCacheTTL(cacheTTL)
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	keys := make([]string, 0)
	for key, row := range s.cache.Entries {
		if cacheRowStale(row, ttl) {
			keys = append(keys, key)
		}
	}
	return keys
}

func cacheRowStale(row homeMarketsCacheRow, ttl time.Duration) bool {
	updated, err := time.Parse(time.RFC3339Nano, row.UpdatedAt)
	if err != nil {
		return true
	}
	return time.Since(updated) >= ttl
}

func cacheKey(league, date, status string, tzOffset int) string {
	return fmt.Sprintf("%s|%s|%s|%d", strings.ToLower(strings.TrimSpace(league)), strings.TrimSpace(date), strings.ToLower(strings.TrimSpace(status)), tzOffset)
}

func parseCacheKey(key string) (string, string, string, int, bool) {
	parts := strings.Split(key, "|")
	if len(parts) != 4 {
		return "", "", "", 0, false
	}
	tzOffset, err := strconv.Atoi(parts[3])
	if err != nil {
		return "", "", "", 0, false
	}
	return parts[0], parts[1], parts[2], tzOffset, true
}

func (s *Service) nbaHomeMarkets(ctx context.Context, cfg models.LeagueConfig, date, status string, tzOffset int) ([]models.HomeMarketItem, error) {
	seriesID := cfg.SeriesID
	if seriesID <= 0 {
		seriesID = nbaDefaultSeriesID
	}
	logrus.WithFields(logrus.Fields{
		"component": "basketball",
		"league":    cfg.Slug,
		"series_id": seriesID,
		"strategy":  "nba_series_first",
	}).Info("nba home markets using series lookup")
	rows, err := s.resolveNBAEventRows(ctx, seriesID, cfg)
	rows = filterRows(rows, date, status, tzOffset, true)
	rows = maybeFilterListingHorizon(rows, date)
	if err == nil && len(rows) > 0 {
		logrus.WithFields(logrus.Fields{
			"component": "basketball",
			"league":    cfg.Slug,
			"series_id": seriesID,
			"count":     len(rows),
			"strategy":  "espn_gamma_slug_series",
		}).Info("nba espn/gamma lookup returned rows")
		return rows, nil
	}
	logrus.WithError(err).WithFields(logrus.Fields{
		"component": "basketball",
		"league":    cfg.Slug,
		"series_id": seriesID,
		"strategy":  "gamma_moneyline_fallback",
		"rows":      len(rows),
	}).Warn("nba espn/gamma lookup empty; using gamma fallback")
	fallback, fallbackErr := s.gammaMoneylineHomeMarkets(ctx, cfg, date, status, tzOffset)
	out := filterRows(fallback, date, status, tzOffset, false)
	out = maybeFilterListingHorizon(out, date)
	return out, fallbackErr
}

func (s *Service) gammaMoneylineHomeMarkets(ctx context.Context, cfg models.LeagueConfig, date, status string, tzOffset int) ([]models.HomeMarketItem, error) {
	query := url.Values{}
	query.Set("active", "true")
	query.Set("closed", "false")
	query.Set("limit", "200")
	query.Set("ascending", "true")
	if cfg.TagID > 0 {
		query.Set("tag_id", fmt.Sprintf("%d", cfg.TagID))
	}
	logrus.WithFields(logrus.Fields{
		"component": "basketball",
		"league":    cfg.Slug,
		"tag_id":    cfg.TagID,
		"strategy":  "gamma_moneyline",
	}).Info("gamma moneyline lookup started")
	rows, err := s.fetchGammaEventsAsRows(ctx, query, cfg)
	rows = filterRows(rows, date, status, tzOffset, false)
	rows = maybeFilterListingHorizon(rows, date)
	return rows, err
}

func (s *Service) gammaEventsBySeries(ctx context.Context, seriesID int64, cfg models.LeagueConfig) ([]models.HomeMarketItem, error) {
	query := url.Values{}
	query.Set("series_id", fmt.Sprintf("%d", seriesID))
	query.Set("active", "true")
	query.Set("closed", "false")
	query.Set("limit", "250")
	logrus.WithFields(logrus.Fields{
		"component": "basketball",
		"league":    cfg.Slug,
		"series_id": seriesID,
		"strategy":  "gamma_series",
	}).Info("gamma series lookup started")
	return s.fetchGammaEventsAsRows(ctx, query, cfg)
}

func (s *Service) resolveNBAEventRows(ctx context.Context, seriesID int64, cfg models.LeagueConfig) ([]models.HomeMarketItem, error) {
	games, err := s.fetchESPNGames(ctx)
	if err != nil {
		return nil, err
	}
	seriesEvents, seriesErr := s.fetchGammaSeriesEvents(ctx, seriesID)
	if seriesErr != nil {
		logrus.WithError(seriesErr).WithFields(logrus.Fields{
			"component": "basketball",
			"series_id": seriesID,
		}).Warn("nba series cache fetch failed")
	}
	rows := make([]models.HomeMarketItem, 0)
	seen := map[string]struct{}{}
	for _, game := range games {
		event, market, tip, ok := s.resolveOneNBAGame(ctx, seriesEvents, cfg.Slug, game)
		if !ok {
			continue
		}
		eventRows := eventMarketRows(event, market, cfg, tip)
		for _, row := range eventRows {
			key := row.ID
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			rows = append(rows, row)
		}
	}
	logrus.WithFields(logrus.Fields{
		"component": "basketball",
		"strategy":  "espn_gamma_slug_series",
		"games":     len(games),
		"series":    len(seriesEvents),
		"row_count": len(rows),
		"series_id": seriesID,
	}).Info("nba espn/gamma rows resolved")
	return rows, nil
}

func (s *Service) fetchESPNGames(ctx context.Context) ([]espnGame, error) {
	dates := shanghaiScoreboardDates()
	seen := map[string]espnGame{}
	for _, date := range dates {
		endpoint := espnNBAScoreboard + "?dates=" + date
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, err
		}
		resp, err := s.httpClient.Do(req)
		if err != nil {
			return nil, err
		}
		var board espnScoreboard
		decodeErr := json.NewDecoder(resp.Body).Decode(&board)
		closeErr := resp.Body.Close()
		if decodeErr != nil {
			return nil, decodeErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("espn scoreboard status %d", resp.StatusCode)
		}
		for _, ev := range board.Events {
			if len(ev.Competitions) == 0 {
				continue
			}
			game := espnGame{ID: ev.ID, Date: ev.Date}
			for _, competitor := range ev.Competitions[0].Competitors {
				if strings.EqualFold(competitor.HomeAway, "home") {
					game.HomeName = competitor.Team.DisplayName
				}
				if strings.EqualFold(competitor.HomeAway, "away") {
					game.AwayName = competitor.Team.DisplayName
				}
			}
			if game.ID != "" && game.HomeName != "" && game.AwayName != "" {
				seen[game.ID] = game
			}
		}
	}
	out := make([]espnGame, 0, len(seen))
	for _, game := range seen {
		out = append(out, game)
	}
	logrus.WithFields(logrus.Fields{
		"component": "basketball",
		"source":    "espn",
		"games":     len(out),
	}).Info("nba espn games loaded")
	return out, nil
}

func (s *Service) fetchGammaSeriesEvents(ctx context.Context, seriesID int64) ([]gammaEvent, error) {
	query := url.Values{}
	query.Set("series_id", fmt.Sprintf("%d", seriesID))
	query.Set("limit", "250")
	query.Set("active", "true")
	query.Set("closed", "false")
	endpoint := "https://gamma-api.polymarket.com/events?" + query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("gamma series status %d", resp.StatusCode)
	}
	var events []gammaEvent
	if err := json.NewDecoder(resp.Body).Decode(&events); err != nil {
		return nil, err
	}
	return events, nil
}

func (s *Service) resolveOneNBAGame(ctx context.Context, seriesEvents []gammaEvent, slugPrefix string, game espnGame) (gammaEvent, gammaMarket, string, bool) {
	home, ok := findNBATeam(game.HomeName)
	if !ok {
		return gammaEvent{}, gammaMarket{}, "", false
	}
	away, ok := findNBATeam(game.AwayName)
	if !ok {
		return gammaEvent{}, gammaMarket{}, "", false
	}
	ha := strings.ToLower(home.Abbr)
	aa := strings.ToLower(away.Abbr)
	seen := map[string]struct{}{}
	var slugs []string
	add := func(s string) {
		if _, ok := seen[s]; ok {
			return
		}
		seen[s] = struct{}{}
		slugs = append(slugs, s)
	}
	if d := slugDateFromESPNGame(game); d != "" {
		add(fmt.Sprintf("%s-%s-%s-%s", slugPrefix, ha, aa, d))
		add(fmt.Sprintf("%s-%s-%s-%s", slugPrefix, aa, ha, d))
	}
	today, yesterday := utcSlugDates()
	for _, d := range []string{today, yesterday} {
		add(fmt.Sprintf("%s-%s-%s-%s", slugPrefix, ha, aa, d))
		add(fmt.Sprintf("%s-%s-%s-%s", slugPrefix, aa, ha, d))
	}
	for _, slug := range slugs {
		ev, err := s.fetchGammaEventBySlug(ctx, slug)
		if err != nil {
			continue
		}
		if isSeriesOrNonSingleGameEvent(ev.Title, ev.Slug) {
			continue
		}
		if market, ok := pickMoneyline(ev.Markets); ok {
			tip := polymarketGameStart(ev, market)
			if strings.TrimSpace(tip) == "" {
				tip = parseESPNDate(game.Date)
			}
			return ev, market, tip, true
		}
	}
	for _, ev := range seriesEvents {
		if ev.Closed || !ev.Active {
			continue
		}
		if isSeriesOrNonSingleGameEvent(ev.Title, ev.Slug) {
			continue
		}
		blob := strings.ToLower(ev.Title + " " + ev.Slug)
		if !strings.Contains(blob, "nba") && !strings.Contains(blob, "basketball") {
			continue
		}
		if !eventTeamMatch(blob, home) || !eventTeamMatch(blob, away) {
			continue
		}
		if market, ok := pickMoneyline(ev.Markets); ok {
			tip := polymarketGameStart(ev, market)
			if strings.TrimSpace(tip) == "" {
				tip = parseESPNDate(game.Date)
			}
			return ev, market, tip, true
		}
	}
	return gammaEvent{}, gammaMarket{}, "", false
}

func (s *Service) fetchGammaEventBySlug(ctx context.Context, slug string) (gammaEvent, error) {
	endpoint := "https://gamma-api.polymarket.com/events/slug/" + url.PathEscape(slug)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return gammaEvent{}, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return gammaEvent{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return gammaEvent{}, errors.New("event slug not found")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return gammaEvent{}, fmt.Errorf("gamma event slug status %d", resp.StatusCode)
	}
	var ev gammaEvent
	if err := json.NewDecoder(resp.Body).Decode(&ev); err != nil {
		return gammaEvent{}, err
	}
	return ev, nil
}

func (s *Service) fetchGammaEventsAsRows(ctx context.Context, query url.Values, cfg models.LeagueConfig) ([]models.HomeMarketItem, error) {
	endpoint := "https://gamma-api.polymarket.com/events?" + query.Encode()
	started := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "basketball",
			"league":    cfg.Slug,
			"endpoint":  endpoint,
		}).Warn("gamma events request failed")
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		logrus.WithFields(logrus.Fields{
			"component": "basketball",
			"league":    cfg.Slug,
			"status":    resp.StatusCode,
			"endpoint":  endpoint,
		}).Warn("gamma events request returned non-success")
		return nil, fmt.Errorf("gamma events status %d", resp.StatusCode)
	}
	var events []gammaEvent
	if err := json.NewDecoder(resp.Body).Decode(&events); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "basketball",
			"league":    cfg.Slug,
			"endpoint":  endpoint,
		}).Warn("gamma events decode failed")
		return nil, err
	}
	logrus.WithFields(logrus.Fields{
		"component":   "basketball",
		"league":      cfg.Slug,
		"event_count": len(events),
		"latency_ms":  time.Since(started).Milliseconds(),
	}).Info("gamma events loaded")
	rows := make([]models.HomeMarketItem, 0)
	for _, ev := range events {
		if !isRealMatchup(ev.Active, ev.Closed, ev.Title) || isSeriesOrNonSingleGameEvent(ev.Title, ev.Slug) {
			continue
		}
		if !eventBelongsToLeague(ev, cfg) {
			logrus.WithFields(logrus.Fields{
				"component": "basketball",
				"league":    cfg.Slug,
				"title":     ev.Title,
				"slug":      ev.Slug,
			}).Debug("gamma event rejected by league filter")
			continue
		}
		market, ok := pickMoneyline(ev.Markets)
		if !ok {
			continue
		}
		start := polymarketGameStart(ev, market)
		rows = append(rows, eventMarketRows(ev, market, cfg, start)...)
	}
	logrus.WithFields(logrus.Fields{
		"component": "basketball",
		"league":    cfg.Slug,
		"rows":      len(rows),
	}).Info("gamma events converted to home market rows")
	return rows, nil
}

func findLeague(leagues []models.LeagueConfig, slug string) (models.LeagueConfig, bool) {
	for _, cfg := range leagues {
		if strings.EqualFold(cfg.Slug, slug) || strings.EqualFold(cfg.Label, slug) {
			return cfg, true
		}
	}
	return models.LeagueConfig{}, false
}

type gammaEvent struct {
	ID        string        `json:"id"`
	Slug      string        `json:"slug"`
	Title     string        `json:"title"`
	StartTime string        `json:"startTime"`
	StartDate string        `json:"startDate"`
	EndDate   string        `json:"endDate"`
	Active    bool          `json:"active"`
	Closed    bool          `json:"closed"`
	Markets   []gammaMarket `json:"markets"`
}

type gammaMarket struct {
	ID             string          `json:"id"`
	Question       string          `json:"question"`
	Slug           string          `json:"slug"`
	ConditionID    string          `json:"conditionId"`
	MarketType     string          `json:"marketType"`
	SportsType     string          `json:"sportsMarketType"`
	StartDate      string          `json:"startDate"`
	GameStartTime  string          `json:"gameStartTime"`
	EventStartTime string          `json:"eventStartTime"`
	Active         bool            `json:"active"`
	Closed         bool            `json:"closed"`
	Outcomes       json.RawMessage `json:"outcomes"`
	OutcomePrices  json.RawMessage `json:"outcomePrices"`
	ClobTokenIDs   json.RawMessage `json:"clobTokenIds"`
	Volume24hr     flexibleFloat   `json:"volume24hr"`
	VolumeNum      flexibleFloat   `json:"volumeNum"`
	Volume         flexibleFloat   `json:"volume"`
}

func eventMarketRows(ev gammaEvent, market gammaMarket, cfg models.LeagueConfig, start string) []models.HomeMarketItem {
	tokens := parseStringArray(market.ClobTokenIDs)
	outcomes := parseStringArray(market.Outcomes)
	prices := parseFloatArray(market.OutcomePrices)
	if len(tokens) != 2 {
		return nil
	}
	if strings.TrimSpace(start) == "" {
		start = polymarketGameStart(ev, market)
	}
	out := make([]models.HomeMarketItem, 0, len(tokens))
	for i, token := range tokens {
		other := ""
		if i == 0 {
			other = tokens[1]
		} else {
			other = tokens[0]
		}
		outcome := ""
		if i < len(outcomes) {
			outcome = outcomes[i]
		}
		mid := 0.0
		if i < len(prices) {
			mid = prices[i]
		}
		q := ev.Title
		if strings.TrimSpace(outcome) != "" {
			q += " · " + outcome
		}
		id := ev.ID + ":" + token
		polyURL := "https://polymarket.com/event/" + ev.Slug
		statusValue := deriveStatus(start, ev.EndDate)
		out = append(out, models.HomeMarketItem{
			ID:              id,
			EventID:         strPtr(ev.ID),
			EventSlug:       strPtr(ev.Slug),
			Question:        q,
			League:          cfg.Label,
			StartTime:       start,
			YesTokenID:      strPtr(token),
			NoTokenID:       strPtr(other),
			OpenPrice:       mid,
			BestBid:         clamp01(mid - 0.005),
			BestAsk:         clamp01(mid + 0.005),
			MidPrice:        mid,
			Spread:          0.01,
			Volume24h:       floatPtr(firstPositive(market.Volume24hr.Float64(), market.VolumeNum.Float64(), market.Volume.Float64())),
			PolymarketURL:   strPtr(polyURL),
			Tier:            tier(mid),
			SuggestedAmount: floatPtr(0),
			MarketID:        strPtr(market.ID),
			ConditionID:     strPtr(market.ConditionID),
			Status:          strPtr(statusValue),
		})
	}
	return out
}

func pickMoneyline(markets []gammaMarket) (gammaMarket, bool) {
	var fallback gammaMarket
	hasFallback := false
	for _, m := range markets {
		if !m.Active || m.Closed {
			continue
		}
		if strings.EqualFold(m.MarketType, "moneyline") {
			return m, true
		}
		q := strings.ToLower(m.Question + " " + m.Slug)
		excluded := []string{"spread", "total", "over", "under", "quarter", "1q", "2q", "3q", "4q", "half", "player"}
		bad := false
		for _, ex := range excluded {
			if strings.Contains(q, ex) && !strings.Contains(q, "thunder") {
				bad = true
				break
			}
		}
		if !bad {
			fallback = m
			hasFallback = true
		}
	}
	return fallback, hasFallback
}

func parseStringArray(raw json.RawMessage) []string {
	var values []string
	if err := json.Unmarshal(raw, &values); err == nil {
		return values
	}
	var encoded string
	if err := json.Unmarshal(raw, &encoded); err == nil {
		_ = json.Unmarshal([]byte(encoded), &values)
	}
	return values
}

func parseFloatArray(raw json.RawMessage) []float64 {
	var nums []float64
	if err := json.Unmarshal(raw, &nums); err == nil {
		return nums
	}
	strs := parseStringArray(raw)
	nums = make([]float64, 0, len(strs))
	for _, s := range strs {
		var f float64
		_, _ = fmt.Sscanf(s, "%f", &f)
		nums = append(nums, f)
	}
	return nums
}

type flexibleFloat float64

func (f *flexibleFloat) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		*f = 0
		return nil
	}
	var n float64
	if err := json.Unmarshal(data, &n); err == nil {
		*f = flexibleFloat(n)
		return nil
	}
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	s = strings.TrimSpace(s)
	if s == "" {
		*f = 0
		return nil
	}
	parsed, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return err
	}
	*f = flexibleFloat(parsed)
	return nil
}

func (f flexibleFloat) Float64() float64 {
	return float64(f)
}

func isRealMatchup(active, closed bool, title string) bool {
	t := strings.ToLower(title)
	format := strings.Contains(t, " vs ") || strings.Contains(t, " vs. ") || strings.Contains(t, " @ ")
	return format && active && !closed
}

func isSeriesOrNonSingleGameEvent(title, slug string) bool {
	t := strings.ToLower(title)
	s := strings.ToLower(slug)
	markers := []string{"who will win series", "will win series", "win the series", "to win the series", "series winner"}
	for _, marker := range markers {
		if strings.Contains(t, marker) {
			return true
		}
	}
	return strings.Contains(s, "series-winner") || strings.Contains(s, "who-wins-series") || strings.Contains(s, "win-series")
}

func eventBelongsToLeague(ev gammaEvent, cfg models.LeagueConfig) bool {
	slug := strings.ToLower(strings.TrimSpace(cfg.Slug))
	text := strings.ToLower(ev.Title + " " + ev.Slug)
	switch slug {
	case "nba":
		if strings.Contains(text, "nhl") || strings.Contains(text, "hockey") {
			return false
		}
		for _, team := range nbaTeams {
			if eventTeamMatch(text, team) {
				return true
			}
		}
		return false
	case "nhl":
		// Do not cross-filter with NBA team names: many cities overlap (e.g. Toronto Maple Leafs
		// matches "Toronto" from Raptors, Philadelphia Flyers matches "Philadelphia" from 76ers),
		// which would drop almost all NHL matchups. Rely on Gamma tag_id + explicit NBA wording.
		if strings.Contains(text, "nba") || strings.Contains(text, "basketball") {
			return false
		}
		return true
	default:
		return true
	}
}

func deriveStatus(startISO, endISO string) string {
	start, err := time.Parse(time.RFC3339, startISO)
	if err != nil {
		return "PRE"
	}
	end := start.Add(4 * time.Hour)
	if parsed, err := time.Parse(time.RFC3339, endISO); err == nil {
		end = parsed
	}
	now := time.Now().UTC()
	if now.Before(start) {
		return "PRE"
	}
	if now.After(end) {
		return "FINAL"
	}
	return "LIVE"
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func tier(mid float64) *string {
	var v string
	switch {
	case mid >= 0.05 && mid <= 0.25:
		v = "A"
	case mid > 0.25 && mid <= 0.55:
		v = "B"
	case mid > 0.55 && mid <= 0.85:
		v = "C"
	default:
		return nil
	}
	return &v
}

func strPtr(v string) *string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	return &v
}

func floatPtr(v float64) *float64 { return &v }

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func firstPositive(values ...float64) float64 {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}

type espnScoreboard struct {
	Events []espnEvent `json:"events"`
}

type espnEvent struct {
	ID           string            `json:"id"`
	Date         string            `json:"date"`
	Competitions []espnCompetition `json:"competitions"`
}

type espnCompetition struct {
	Competitors []espnCompetitor `json:"competitors"`
}

type espnCompetitor struct {
	HomeAway string   `json:"homeAway"`
	Team     espnTeam `json:"team"`
}

type espnTeam struct {
	DisplayName string `json:"displayName"`
}

type espnGame struct {
	ID       string
	Date     string
	HomeName string
	AwayName string
}

type nbaTeam struct {
	Abbr     string
	ESPNName string
}

var nbaTeams = []nbaTeam{
	{"ATL", "Atlanta Hawks"},
	{"BOS", "Boston Celtics"},
	{"BKN", "Brooklyn Nets"},
	{"CHA", "Charlotte Hornets"},
	{"CHI", "Chicago Bulls"},
	{"CLE", "Cleveland Cavaliers"},
	{"DAL", "Dallas Mavericks"},
	{"DEN", "Denver Nuggets"},
	{"DET", "Detroit Pistons"},
	{"GSW", "Golden State Warriors"},
	{"HOU", "Houston Rockets"},
	{"IND", "Indiana Pacers"},
	{"LAC", "LA Clippers"},
	{"LAL", "Los Angeles Lakers"},
	{"MEM", "Memphis Grizzlies"},
	{"MIA", "Miami Heat"},
	{"MIL", "Milwaukee Bucks"},
	{"MIN", "Minnesota Timberwolves"},
	{"NOP", "New Orleans Pelicans"},
	{"NYK", "New York Knicks"},
	{"OKC", "Oklahoma City Thunder"},
	{"ORL", "Orlando Magic"},
	{"PHI", "Philadelphia 76ers"},
	{"PHX", "Phoenix Suns"},
	{"POR", "Portland Trail Blazers"},
	{"SAC", "Sacramento Kings"},
	{"SAS", "San Antonio Spurs"},
	{"TOR", "Toronto Raptors"},
	{"UTA", "Utah Jazz"},
	{"WAS", "Washington Wizards"},
}

func findNBATeam(name string) (nbaTeam, bool) {
	n := strings.ToLower(strings.TrimSpace(name))
	for _, team := range nbaTeams {
		if strings.ToLower(team.ESPNName) == n {
			return team, true
		}
	}
	for _, team := range nbaTeams {
		parts := strings.Fields(strings.ToLower(team.ESPNName))
		if len(parts) == 0 {
			continue
		}
		last := parts[len(parts)-1]
		if strings.Contains(n, last) || strings.Contains(last, n) {
			return team, true
		}
	}
	return nbaTeam{}, false
}

func eventTeamMatch(text string, team nbaTeam) bool {
	x := strings.ToLower(text)
	if strings.Contains(x, strings.ToLower(team.Abbr)) {
		return true
	}
	for _, part := range strings.Fields(team.ESPNName) {
		w := strings.ToLower(part)
		if len(w) >= 3 && strings.Contains(x, w) {
			return true
		}
	}
	return false
}

func shanghaiScoreboardDates() []string {
	now := time.Now().UTC().Add(8 * time.Hour)
	start := dateOnly(now).AddDate(0, 0, -1)
	out := make([]string, 0, 10)
	for i := 0; i < 10; i++ { // yesterday + 9 more days ≈ one week ahead in ESPN local calendar
		out = append(out, start.AddDate(0, 0, i).Format("20060102"))
	}
	return out
}

func dateOnly(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}

func utcSlugDates() (string, string) {
	today := time.Now().UTC()
	return today.Format("2006-01-02"), today.AddDate(0, 0, -1).Format("2006-01-02")
}

func parseESPNDate(raw string) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(raw))
	if err != nil {
		return raw
	}
	return t.UTC().Format(time.RFC3339)
}

// slugDateFromESPNGame yields UTC calendar date for Polymarket slug patterns (nba-aaa-bbb-YYYY-MM-DD).
func slugDateFromESPNGame(game espnGame) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(game.Date))
	if err != nil {
		return ""
	}
	return t.UTC().Format("2006-01-02")
}

func maybeFilterListingHorizon(rows []models.HomeMarketItem, date string) []models.HomeMarketItem {
	if strings.TrimSpace(date) != "" {
		return rows
	}
	return filterListingHorizon(rows, listingHorizonDays)
}

func filterListingHorizon(rows []models.HomeMarketItem, horizonDays int) []models.HomeMarketItem {
	if horizonDays <= 0 || len(rows) == 0 {
		return rows
	}
	now := time.Now().UTC()
	min := now.Add(-48 * time.Hour)
	max := now.Add(time.Duration(horizonDays) * 24 * time.Hour)
	out := make([]models.HomeMarketItem, 0, len(rows))
	for _, row := range rows {
		t, err := time.Parse(time.RFC3339, strings.TrimSpace(row.StartTime))
		if err != nil {
			out = append(out, row)
			continue
		}
		tu := t.UTC()
		if (tu.Equal(min) || tu.After(min)) && (tu.Before(max) || tu.Equal(max)) {
			out = append(out, row)
		}
	}
	return out
}

func polymarketGameStart(ev gammaEvent, market gammaMarket) string {
	for _, raw := range []string{ev.StartTime, market.GameStartTime, market.EventStartTime, market.StartDate, ev.StartDate} {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		if t, err := time.Parse(time.RFC3339, strings.TrimSpace(raw)); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
		return raw
	}
	return ""
}

func filterRows(rows []models.HomeMarketItem, date, status string, tzOffset int, useNYDate bool) []models.HomeMarketItem {
	if date == "" && (status == "" || strings.EqualFold(status, "all")) {
		return rows
	}
	out := rows[:0]
	for _, row := range rows {
		if date != "" {
			rowDate := localYMD(row.StartTime, tzOffset)
			if useNYDate {
				rowDate = newYorkYMD(row.StartTime)
			}
			if rowDate != date {
				continue
			}
		}
		if !passesStatus(row.Status, status) {
			continue
		}
		out = append(out, row)
	}
	return out
}

func localYMD(raw string, tzOffset int) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	// Browser getTimezoneOffset is minutes west of UTC.
	return t.Add(time.Duration(-tzOffset) * time.Minute).Format("2006-01-02")
}

func newYorkYMD(raw string) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return t.UTC().Format("2006-01-02")
	}
	return t.In(loc).Format("2006-01-02")
}

func passesStatus(rowStatus *string, filter string) bool {
	f := strings.ToLower(strings.TrimSpace(filter))
	if f == "" || f == "all" {
		return true
	}
	st := ""
	if rowStatus != nil {
		st = strings.ToUpper(*rowStatus)
	}
	switch f {
	case "active":
		return st == "PRE" || st == "LIVE"
	case "live":
		return st == "LIVE"
	default:
		return true
	}
}
