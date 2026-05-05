package positions

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/drinkthere/polyserver/internal/models"
	"github.com/drinkthere/polyserver/internal/storage"
	"github.com/sirupsen/logrus"
)

const stateSchema = "positions-state-v1"

// Store persists positions and risk settings.
type Store struct {
	path     string
	mu       sync.RWMutex
	risk     models.RiskConfig
	byID     map[string]models.Position
	tasks    map[string]models.CloseTask
	riskKeys map[string]struct{}
}

// Load reads positions-state.json.
func Load(ctx context.Context, path string) (*Store, error) {
	s := &Store{
		path:     path,
		risk:     models.DefaultRiskConfig(),
		byID:     map[string]models.Position{},
		tasks:    map[string]models.CloseTask{},
		riskKeys: map[string]struct{}{},
	}
	var file models.PositionsStateFile
	if err := storage.LoadJSON(ctx, path, &file); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "positions",
			"path":      path,
		}).Error("positions load failed")
		return nil, err
	}
	if file.Risk.DefaultStopTrailPct != 0 {
		s.risk = file.Risk
	}
	for _, p := range file.Positions {
		s.byID[p.ID] = p
	}
	for _, t := range file.CloseTasks {
		s.tasks[closeTaskKey(t.PositionID, t.Kind)] = t
	}
	for _, k := range file.RiskKeys {
		s.riskKeys[k] = struct{}{}
	}
	logrus.WithFields(logrus.Fields{
		"component":      "positions",
		"path":           path,
		"position_count": len(s.byID),
		"close_tasks":    len(s.tasks),
		"risk_keys":      len(s.riskKeys),
	}).Info("positions loaded")
	return s, nil
}

// Risk returns the current risk config.
func (s *Store) Risk() models.RiskConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.risk
}

// ListAll returns all positions.
func (s *Store) ListAll() []models.Position {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]models.Position, 0, len(s.byID))
	for _, p := range s.byID {
		out = append(out, p)
	}
	return out
}

// ListOpen returns open positions.
func (s *Store) ListOpen() []models.Position {
	all := s.ListAll()
	out := all[:0]
	for _, p := range all {
		if p.State == "open" {
			out = append(out, p)
		}
	}
	return out
}

// ListForPriceFeed returns positions that need price updates.
func (s *Store) ListForPriceFeed() []models.Position {
	all := s.ListAll()
	out := all[:0]
	for _, p := range all {
		if p.TokenID != "" && (p.State == "open" || p.State == "stopped_out") {
			out = append(out, p)
		}
	}
	return out
}

// ListCloseTasks returns pending close tasks.
func (s *Store) ListCloseTasks() []models.CloseTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]models.CloseTask, 0, len(s.tasks))
	for _, t := range s.tasks {
		out = append(out, t)
	}
	return out
}

// ListCloseTasksReady returns retry tasks whose retry time has arrived.
func (s *Store) ListCloseTasksReady(now time.Time) []models.CloseTask {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]models.CloseTask, 0, len(s.tasks))
	for _, t := range s.tasks {
		when, err := time.Parse(time.RFC3339Nano, t.NextRetryAt)
		if err != nil || !when.After(now) {
			out = append(out, t)
		}
	}
	return out
}

// Get returns one position by id.
func (s *Store) Get(id string) (models.Position, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.byID[id]
	return p, ok
}

// Upsert stores a position.
func (s *Store) Upsert(ctx context.Context, p models.Position) (models.Position, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if p.ID == "" {
		p.ID = fmt.Sprintf("%d", time.Now().UnixNano())
	}
	if p.CreatedAt == "" {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	s.mu.Lock()
	_, existed := s.byID[p.ID]
	s.byID[p.ID] = p
	s.mu.Unlock()
	if err := s.persist(ctx); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component":   "positions",
			"position_id": p.ID,
			"token_id":    p.TokenID,
		}).Error("position persist failed")
		return p, err
	}
	logrus.WithFields(logrus.Fields{
		"component":   "positions",
		"position_id": p.ID,
		"token_id":    p.TokenID,
		"state":       p.State,
		"paper":       p.Paper,
		"existed":     existed,
	}).Info("position upserted")
	return p, nil
}

// Register creates a monitoring position from a frontend request.
func (s *Store) Register(ctx context.Context, req models.RegisterPositionRequest) (models.Position, error) {
	if req.MarketID == "" || req.TokenID == "" || req.Shares <= 0 || req.CostUSDC <= 0 {
		return models.Position{}, fmt.Errorf("marketId, tokenId, shares, and costUsdc are required")
	}
	trail := req.StopTrailPct
	if trail <= 0 {
		trail = s.Risk().DefaultStopTrailPct
	}
	id := ""
	if req.ID != nil {
		id = *req.ID
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	p := models.Position{
		ID:               id,
		MarketID:         req.MarketID,
		ConditionID:      req.ConditionID,
		EventID:          req.EventID,
		TokenID:          req.TokenID,
		Shares:           req.Shares,
		AvgEntryPrice:    req.AvgEntryPrice,
		CostUSDC:         req.CostUSDC,
		StopTrailPct:     trail,
		OutcomeLabel:     req.OutcomeLabel,
		State:            "open",
		HighWaterMark:    req.AvgEntryPrice,
		MonitoringActive: true,
		Paper:            req.Paper,
		CreatedAt:        now,
		UpdatedAt:        now,
	}
	return s.Upsert(ctx, p)
}

// Update mutates a single position and persists it.
func (s *Store) Update(ctx context.Context, id string, fn func(*models.Position)) (models.Position, bool, error) {
	s.mu.Lock()
	p, ok := s.byID[id]
	if !ok {
		s.mu.Unlock()
		return models.Position{}, false, nil
	}
	fn(&p)
	p.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.byID[id] = p
	s.mu.Unlock()
	if err := s.persist(ctx); err != nil {
		return p, true, err
	}
	logrus.WithFields(logrus.Fields{
		"component":   "positions",
		"position_id": id,
		"state":       p.State,
	}).Info("position updated")
	return p, true, nil
}

// SetRisk updates the trailing-stop risk configuration.
func (s *Store) SetRisk(ctx context.Context, defaultStopTrailPct *float64, minTickDebounceMs *int) (models.RiskConfig, error) {
	s.mu.Lock()
	if defaultStopTrailPct != nil {
		s.risk.DefaultStopTrailPct = math.Max(0, math.Min(*defaultStopTrailPct, 0.99))
	}
	if minTickDebounceMs != nil {
		if *minTickDebounceMs < 0 {
			s.risk.MinTickDebounceMs = 0
		} else {
			s.risk.MinTickDebounceMs = *minTickDebounceMs
		}
	}
	cfg := s.risk
	s.mu.Unlock()
	if err := s.persist(ctx); err != nil {
		return cfg, err
	}
	logrus.WithFields(logrus.Fields{
		"component":              "risk",
		"default_stop_trail_pct": cfg.DefaultStopTrailPct,
		"min_tick_debounce_ms":   cfg.MinTickDebounceMs,
	}).Info("risk config updated")
	return cfg, nil
}

// HasPendingCloseTask reports whether a close task exists.
func (s *Store) HasPendingCloseTask(positionID, kind string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.tasks[closeTaskKey(positionID, kind)]
	return ok
}

// RecordCloseFailure creates or updates a close retry task with backoff.
func (s *Store) RecordCloseFailure(ctx context.Context, positionID, kind, errText string) error {
	now := time.Now().UTC()
	s.mu.Lock()
	key := closeTaskKey(positionID, kind)
	task := s.tasks[key]
	if task.PositionID == "" {
		task = models.CloseTask{
			PositionID: positionID,
			Kind:       kind,
			CreatedAt:  now.Format(time.RFC3339Nano),
		}
	}
	task.FailCount++
	msg := errText
	task.LastError = &msg
	last := now.Format(time.RFC3339Nano)
	task.LastAttemptAt = &last
	delay := time.Duration(5*task.FailCount) * time.Second
	if delay > 2*time.Minute {
		delay = 2 * time.Minute
	}
	task.NextRetryAt = now.Add(delay).Format(time.RFC3339Nano)
	s.tasks[key] = task
	s.mu.Unlock()
	if err := s.persist(ctx); err != nil {
		return err
	}
	logrus.WithFields(logrus.Fields{
		"component":   "stop_loss",
		"position_id": positionID,
		"kind":        kind,
		"fail_count":  task.FailCount,
		"next_retry":  task.NextRetryAt,
	}).Warn("close task recorded")
	return nil
}

// RemoveCloseTask deletes a pending close task.
func (s *Store) RemoveCloseTask(ctx context.Context, positionID, kind string) error {
	s.mu.Lock()
	delete(s.tasks, closeTaskKey(positionID, kind))
	s.mu.Unlock()
	return s.persist(ctx)
}

func (s *Store) persist(ctx context.Context) error {
	s.mu.RLock()
	file := models.PositionsStateFile{
		Risk:       s.risk,
		Positions:  make([]models.Position, 0, len(s.byID)),
		RiskKeys:   make([]string, 0, len(s.riskKeys)),
		CloseTasks: make([]models.CloseTask, 0, len(s.tasks)),
	}
	schema := stateSchema
	file.Schema = &schema
	for _, p := range s.byID {
		file.Positions = append(file.Positions, p)
	}
	for k := range s.riskKeys {
		file.RiskKeys = append(file.RiskKeys, k)
	}
	for _, t := range s.tasks {
		file.CloseTasks = append(file.CloseTasks, t)
	}
	s.mu.RUnlock()
	logrus.WithFields(logrus.Fields{
		"component":      "positions",
		"path":           s.path,
		"position_count": len(file.Positions),
		"close_tasks":    len(file.CloseTasks),
	}).Debug("positions persist started")
	return storage.SaveJSONAtomic(ctx, s.path, file)
}

func closeTaskKey(positionID, kind string) string {
	return positionID + "|" + kind
}
