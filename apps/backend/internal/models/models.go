package models

// LeagueConfig mirrors the Rust backend leagues.json shape.
type LeagueConfig struct {
	Slug     string  `json:"slug"`
	Name     string  `json:"name"`
	Label    string  `json:"label"`
	SeriesID int64   `json:"series_id,omitempty"`
	TagID    int64   `json:"tagId"`
	Icon     *string `json:"icon,omitempty"`
}

// LeaguesFile is the persisted league configuration.
type LeaguesFile struct {
	Leagues []LeagueConfig `json:"leagues"`
}

// AccountRecord mirrors the Rust backend account type and preserves account kind fields.
type AccountRecord struct {
	ID                 string `json:"id"`
	AccountID          int    `json:"accountId"`
	Label              string `json:"label"`
	EVMPrivateKey      string `json:"evmPrivateKey"`
	EOAAddress         string `json:"eoaAddress"`
	ProxyWalletAddress string `json:"proxyWalletAddress"`
	APIKey             string `json:"apiKey"`
	APISecret          string `json:"apiSecret"`
	APIPassphrase      string `json:"apiPassphrase"`
	DerivedAt          string `json:"derivedAt"`
}

// CreateAccountRequest is the frontend payload for deriving a backend trading account.
type CreateAccountRequest struct {
	Label         *string `json:"label,omitempty"`
	EVMPrivateKey string  `json:"evmPrivateKey"`
}

// HasCLOBCredentials reports whether the account has L2 CLOB credentials.
func (a AccountRecord) HasCLOBCredentials() bool {
	return a.APIKey != "" && a.APISecret != "" && a.APIPassphrase != ""
}

// AccountsFile is data/derived-credentials.json.
type AccountsFile struct {
	Schema    *string         `json:"schema,omitempty"`
	DefaultID string          `json:"defaultId"`
	Accounts  []AccountRecord `json:"accounts"`
}

// AccountView is returned to the frontend.
type AccountView struct {
	ID                 string  `json:"id"`
	Label              string  `json:"label"`
	EOAAddress         string  `json:"eoaAddress"`
	ProxyWalletAddress *string `json:"proxyWalletAddress,omitempty"`
	IsDefault          bool    `json:"isDefault"`
	USDCBalance        float64 `json:"usdcBalance"`
	PortfolioValue     float64 `json:"portfolioValue"`
	BalanceNote        string  `json:"balanceNote"`
	HasCLOBCredentials bool    `json:"hasClobCredentials"`
}

// PlaceOrderRequest is a CLOB market order request from the frontend.
type PlaceOrderRequest struct {
	TokenID    string   `json:"tokenId"`
	Side       *string  `json:"side,omitempty"`
	AmountUSDC float64  `json:"amountUsdc"`
	Price      *float64 `json:"price,omitempty"`
	OrderType  *string  `json:"orderType,omitempty"`
	DryRun     bool     `json:"dryRun,omitempty"`
}

// MarketSellRequest closes shares for one CLOB token.
type MarketSellRequest struct {
	TokenID string  `json:"tokenId"`
	Shares  float64 `json:"shares"`
	DryRun  bool    `json:"dryRun,omitempty"`
}

// CloseAllTradingRequest closes multiple legs after canceling open orders.
type CloseAllTradingRequest struct {
	Sells []CloseAllSellLeg `json:"sells,omitempty"`
}

// CloseAllSellLeg is one sell leg for close-all.
type CloseAllSellLeg struct {
	TokenID string  `json:"tokenId"`
	Shares  float64 `json:"shares"`
}

// RegisterPositionRequest registers a bought position for monitoring.
type RegisterPositionRequest struct {
	ID            *string `json:"id,omitempty"`
	MarketID      string  `json:"marketId"`
	ConditionID   *string `json:"conditionId,omitempty"`
	EventID       *string `json:"eventId,omitempty"`
	TokenID       string  `json:"tokenId"`
	Shares        float64 `json:"shares"`
	AvgEntryPrice float64 `json:"avgEntryPrice"`
	CostUSDC      float64 `json:"costUsdc"`
	StopTrailPct  float64 `json:"stopTrailPct"`
	OutcomeLabel  *string `json:"outcomeLabel,omitempty"`
	Paper         bool    `json:"paper,omitempty"`
}

// TierConfig is the UI risk bucket used to choose trailing-stop plans.
type TierConfig struct {
	ID              string  `json:"id"`
	Label           string  `json:"label"`
	Min             float64 `json:"min"`
	Max             float64 `json:"max"`
	AllocPct        float64 `json:"allocPct"`
	DefaultStopLoss float64 `json:"defaultStopLoss"`
}

// RiskConfig mirrors positions-state.json risk config.
type RiskConfig struct {
	DefaultStopTrailPct float64 `json:"defaultStopTrailPct"`
	MinTickDebounceMs   int     `json:"minTickDebounceMs"`
}

// DefaultRiskConfig returns Rust-compatible defaults.
func DefaultRiskConfig() RiskConfig {
	return RiskConfig{DefaultStopTrailPct: 0.10, MinTickDebounceMs: 100}
}

// Position mirrors the Rust backend persisted position model.
type Position struct {
	ID               string  `json:"id"`
	MarketID         string  `json:"marketId"`
	ConditionID      *string `json:"conditionId,omitempty"`
	EventID          *string `json:"eventId,omitempty"`
	TokenID          string  `json:"tokenId"`
	Shares           float64 `json:"shares"`
	AvgEntryPrice    float64 `json:"avgEntryPrice"`
	CostUSDC         float64 `json:"costUsdc"`
	StopTrailPct     float64 `json:"stopTrailPct"`
	OutcomeLabel     *string `json:"outcomeLabel,omitempty"`
	State            string  `json:"state"`
	HighWaterMark    float64 `json:"highWaterMark"`
	MonitoringActive bool    `json:"monitoringActive"`
	Paper            bool    `json:"paper,omitempty"`
	External         bool    `json:"external,omitempty"`
	AutoRegistered   bool    `json:"auto_registered,omitempty"`
	GameStartAt      *string `json:"gameStartAt,omitempty"`
	CreatedAt        string  `json:"createdAt"`
	UpdatedAt        string  `json:"updatedAt"`
}

// CloseTask is a pending close retry record.
type CloseTask struct {
	PositionID    string  `json:"positionId"`
	Kind          string  `json:"kind"`
	FailCount     int     `json:"failCount"`
	LastError     *string `json:"lastError,omitempty"`
	NextRetryAt   string  `json:"nextRetryAt"`
	CreatedAt     string  `json:"createdAt"`
	LastAttemptAt *string `json:"lastAttemptAt,omitempty"`
}

// PositionsStateFile is data/positions-state.json.
type PositionsStateFile struct {
	Schema     *string     `json:"schema,omitempty"`
	Risk       RiskConfig  `json:"risk"`
	Positions  []Position  `json:"positions"`
	RiskKeys   []string    `json:"risk_keys"`
	CloseTasks []CloseTask `json:"closeTasks"`
}

// HomeMarketItem is the frontend market row.
type HomeMarketItem struct {
	ID              string   `json:"id"`
	EventID         *string  `json:"eventId,omitempty"`
	EventSlug       *string  `json:"eventSlug,omitempty"`
	Question        string   `json:"question"`
	League          string   `json:"league"`
	StartTime       string   `json:"startTime"`
	YesTokenID      *string  `json:"yesTokenId,omitempty"`
	NoTokenID       *string  `json:"noTokenId,omitempty"`
	OpenPrice       float64  `json:"openPrice"`
	BestBid         float64  `json:"bestBid"`
	BestAsk         float64  `json:"bestAsk"`
	MidPrice        float64  `json:"midPrice"`
	Spread          float64  `json:"spread"`
	BidDepth        float64  `json:"bidDepth"`
	AskDepth        float64  `json:"askDepth"`
	Volume24h       *float64 `json:"volume24h,omitempty"`
	PolymarketURL   *string  `json:"polymarketUrl,omitempty"`
	ChineseSubtitle *string  `json:"chineseSubtitle,omitempty"`
	Tier            *string  `json:"tier,omitempty"`
	SuggestedAmount *float64 `json:"suggestedAmount,omitempty"`
	MarketID        *string  `json:"marketId,omitempty"`
	ConditionID     *string  `json:"conditionId,omitempty"`
	Status          *string  `json:"status,omitempty"`
}

// MonitorSnapshot mirrors the frontend monitor payload.
type MonitorSnapshot struct {
	TotalCostUSDC     float64              `json:"totalCostUsdc"`
	TotalMarkValueBid float64              `json:"totalMarkValueBid"`
	UnrealizedMidUSDC float64              `json:"unrealizedMidUsdc"`
	UnrealizedPctMid  float64              `json:"unrealizedPctMid"`
	Positions         []MonitorPositionRow `json:"positions"`
	Risk              RiskConfig           `json:"risk"`
	Timestamp         string               `json:"timestamp"`
}

// MonitorPositionRow is one row in a monitor snapshot.
type MonitorPositionRow struct {
	ID                string   `json:"id"`
	MarketID          string   `json:"marketId"`
	EventID           *string  `json:"eventId,omitempty"`
	TokenID           string   `json:"tokenId"`
	Shares            float64  `json:"shares"`
	CostUSDC          float64  `json:"costUsdc"`
	StopTrailPct      float64  `json:"stopTrailPct"`
	OutcomeLabel      *string  `json:"outcomeLabel,omitempty"`
	State             string   `json:"state"`
	MonitoringActive  bool     `json:"monitoringActive"`
	HighWaterMark     float64  `json:"highWaterMark"`
	Bid               *float64 `json:"bid,omitempty"`
	Ask               *float64 `json:"ask,omitempty"`
	Mid               *float64 `json:"mid,omitempty"`
	UnrealizedMidUSDC float64  `json:"unrealizedMidUsdc"`
	Paper             bool     `json:"paper,omitempty"`
}
