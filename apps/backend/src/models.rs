use serde::{Deserialize, Serialize};

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeagueConfig {
    pub slug: String,
    pub name: String,
    pub label: String,
    #[serde(default)]
    pub series_id: i64,
    #[serde(rename = "tagId")]
    pub tag_id: i64,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaguesFile {
    pub leagues: Vec<LeagueConfig>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeMarketItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_slug: Option<String>,
    pub question: String,
    pub league: String,
    pub start_time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yes_token_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_token_id: Option<String>,
    pub open_price: f64,
    pub best_bid: f64,
    pub best_ask: f64,
    pub mid_price: f64,
    pub spread: f64,
    pub bid_depth: f64,
    pub ask_depth: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume24h: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polymarket_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chinese_subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HomeMarketsData {
    pub markets: Vec<HomeMarketItem>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiHomeMarketsResponse {
    pub success: bool,
    pub data: HomeMarketsData,
    pub timestamp: String,
    pub cached: bool,
}

#[derive(Debug, Deserialize)]
pub struct HomeTicksBody {
    #[serde(rename = "tokenIds")]
    pub token_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub token_id: String,
    pub midpoint: f64,
    pub best_bid: f64,
    pub best_ask: f64,
}

#[derive(Debug, Deserialize)]
pub struct PlaceOrderRequest {
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub side: Option<String>,
    #[serde(rename = "amountUsdc")]
    pub amount_usdc: f64,
    pub price: Option<f64>,
    #[serde(rename = "orderType")]
    pub order_type: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize)]
pub struct MarketSellRequest {
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub shares: f64,
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Debug, Deserialize)]
pub struct CloseAllTradingRequest {
    pub sells: Option<Vec<CloseAllSellLeg>>,
}

#[derive(Debug, Deserialize)]
pub struct CloseAllSellLeg {
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub shares: f64,
}

#[derive(Debug, Deserialize)]
pub struct RegisterPositionRequest {
    pub id: Option<String>,
    #[serde(rename = "marketId")]
    pub market_id: String,
    #[serde(rename = "conditionId")]
    pub condition_id: Option<String>,
    #[serde(rename = "eventId")]
    pub event_id: Option<String>,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub shares: f64,
    #[serde(rename = "avgEntryPrice")]
    pub avg_entry_price: f64,
    #[serde(rename = "costUsdc")]
    pub cost_usdc: f64,
    #[serde(rename = "stopTrailPct")]
    pub stop_trail_pct: f64,
    #[serde(rename = "outcomeLabel")]
    pub outcome_label: Option<String>,
    #[serde(default)]
    pub paper: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub id: String,
    #[serde(rename = "marketId")]
    pub market_id: String,
    #[serde(rename = "conditionId", skip_serializing_if = "Option::is_none")]
    pub condition_id: Option<String>,
    #[serde(rename = "eventId", skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub shares: f64,
    #[serde(rename = "avgEntryPrice")]
    pub avg_entry_price: f64,
    #[serde(rename = "costUsdc")]
    pub cost_usdc: f64,
    #[serde(rename = "stopTrailPct")]
    pub stop_trail_pct: f64,
    #[serde(rename = "outcomeLabel", skip_serializing_if = "Option::is_none")]
    pub outcome_label: Option<String>,
    pub state: String,
    #[serde(rename = "highWaterMark")]
    pub high_water_mark: f64,
    #[serde(rename = "monitoringActive")]
    pub monitoring_active: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub paper: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub external: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub auto_registered: bool,
    #[serde(rename = "gameStartAt", skip_serializing_if = "Option::is_none")]
    pub game_start_at: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskConfig {
    #[serde(rename = "defaultStopTrailPct", default = "risk_default_trail")]
    pub default_stop_trail_pct: f64,
    #[serde(rename = "minTickDebounceMs", default = "risk_default_debounce")]
    pub min_tick_debounce_ms: i32,
}

fn risk_default_trail() -> f64 {
    0.10
}

fn risk_default_debounce() -> i32 {
    100
}

impl Default for RiskConfig {
    fn default() -> Self {
        Self {
            default_stop_trail_pct: risk_default_trail(),
            min_tick_debounce_ms: risk_default_debounce(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionsStateFile {
    pub schema: Option<String>,
    pub risk: RiskConfig,
    pub positions: Vec<Position>,
    #[serde(default)]
    pub risk_keys: Vec<String>,
    #[serde(default, rename = "closeTasks")]
    pub close_tasks: Vec<CloseTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseTask {
    #[serde(rename = "positionId")]
    pub position_id: String,
    pub kind: String,
    #[serde(rename = "failCount")]
    pub fail_count: i32,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(rename = "nextRetryAt")]
    pub next_retry_at: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastAttemptAt", skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MonitorSnapshot {
    #[serde(rename = "totalCostUsdc")]
    pub total_cost_usdc: f64,
    #[serde(rename = "totalMarkValueBid")]
    pub total_mark_value_bid: f64,
    #[serde(rename = "unrealizedMidUsdc")]
    pub unrealized_mid_usdc: f64,
    #[serde(rename = "unrealizedPctMid")]
    pub unrealized_pct_mid: f64,
    pub positions: Vec<MonitorPositionRow>,
    pub risk: RiskConfig,
    pub timestamp: String,
}

#[derive(Debug, Serialize)]
pub struct MonitorPositionRow {
    pub id: String,
    #[serde(rename = "marketId")]
    pub market_id: String,
    #[serde(rename = "eventId", skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub shares: f64,
    #[serde(rename = "costUsdc")]
    pub cost_usdc: f64,
    #[serde(rename = "stopTrailPct")]
    pub stop_trail_pct: f64,
    #[serde(rename = "outcomeLabel", skip_serializing_if = "Option::is_none")]
    pub outcome_label: Option<String>,
    pub state: String,
    #[serde(rename = "monitoringActive")]
    pub monitoring_active: bool,
    #[serde(rename = "highWaterMark")]
    pub high_water_mark: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bid: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mid: Option<f64>,
    #[serde(rename = "unrealizedMidUsdc")]
    pub unrealized_mid_usdc: f64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub paper: bool,
}

#[derive(Debug, Deserialize)]
pub struct PaperResolveRequest {
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct PaperResolveResponse {
    pub slug: String,
    #[serde(rename = "eventId")]
    pub event_id: String,
    pub title: String,
    pub markets: Vec<PaperResolvedMarket>,
}

#[derive(Debug, Serialize)]
pub struct PaperResolvedMarket {
    #[serde(rename = "marketId")]
    pub market_id: String,
    pub question: String,
    pub outcomes: Vec<PaperOutcomeRef>,
}

#[derive(Debug, Serialize)]
pub struct PaperOutcomeRef {
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub outcome: String,
}

#[derive(Debug, Deserialize)]
pub struct PaperSimulateBuyRequest {
    #[serde(rename = "marketId")]
    pub market_id: String,
    #[serde(rename = "eventId")]
    pub event_id: Option<String>,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    pub usdc: f64,
    #[serde(rename = "stopTrailPct")]
    pub stop_trail_pct: f64,
    #[serde(default)]
    pub arm: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateAccountRequest {
    pub label: Option<String>,
    #[serde(rename = "evmPrivateKey")]
    pub evm_private_key: String,
}

#[derive(Debug, Serialize)]
pub struct AccountView {
    pub id: String,
    pub label: String,
    #[serde(rename = "eoaAddress")]
    pub eoa_address: String,
    #[serde(rename = "proxyWalletAddress", skip_serializing_if = "Option::is_none")]
    pub proxy_wallet_address: Option<String>,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    #[serde(rename = "usdcBalance")]
    pub usdc_balance: f64,
    #[serde(rename = "portfolioValue")]
    pub portfolio_value: f64,
    #[serde(rename = "balanceNote")]
    pub balance_note: String,
    #[serde(rename = "hasClobCredentials")]
    pub has_clob_credentials: bool,
}

#[derive(Debug, Serialize)]
pub struct AccountsListResponse {
    #[serde(rename = "defaultId")]
    pub default_id: String,
    pub accounts: Vec<AccountView>,
}

/// On-disk layout matches Go `accounts.Record` / `derived-credentials-v1`
/// (`evm_private_key`, `proxy_address`, `name`, L2 API fields).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountRecord {
    pub id: String,
    /// Monotonic index; Go assigns on add.
    #[serde(default)]
    pub account_id: i32,
    /// Go JSON key is `name`; we still accept legacy `label`.
    #[serde(rename = "name", alias = "label", default)]
    pub label: String,
    #[serde(rename = "evm_private_key", alias = "evmPrivateKey")]
    pub evm_private_key: String,
    #[serde(default, rename = "eoa_address", alias = "eoaAddress")]
    pub eoa_address: String,
    #[serde(default, rename = "proxy_address", alias = "proxyWalletAddress")]
    pub proxy_wallet_address: String,
    #[serde(default, rename = "api_key", alias = "apiKey")]
    pub api_key: String,
    #[serde(default, rename = "api_secret", alias = "apiSecret")]
    pub api_secret: String,
    #[serde(
        default,
        rename = "api_passphrase",
        alias = "passphrase",
        alias = "apiPassphrase"
    )]
    pub api_passphrase: String,
    #[serde(default, rename = "derived_at", alias = "derivedAt")]
    pub derived_at: String,
}

impl AccountRecord {
    pub fn has_clob_credentials(&self) -> bool {
        !self.api_key.trim().is_empty()
            && !self.api_secret.trim().is_empty()
            && !self.api_passphrase.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountsFile {
    #[serde(rename = "schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(rename = "defaultId")]
    pub default_id: String,
    pub accounts: Vec<AccountRecord>,
}

impl Default for AccountsFile {
    fn default() -> Self {
        Self {
            schema: None,
            default_id: String::new(),
            accounts: vec![],
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ReconcileRow {
    #[serde(rename = "tokenId")]
    pub token_id: String,
    #[serde(rename = "localId", skip_serializing_if = "Option::is_none")]
    pub local_id: Option<String>,
    #[serde(rename = "marketId", skip_serializing_if = "Option::is_none")]
    pub market_id: Option<String>,
    #[serde(rename = "localShares")]
    pub local_shares: f64,
    #[serde(rename = "chainShares", skip_serializing_if = "Option::is_none")]
    pub chain_shares: Option<f64>,
    pub drift: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReconcileResponse {
    pub proxy: String,
    pub rows: Vec<ReconcileRow>,
}

#[derive(Debug, Serialize)]
pub struct ClosedHistoryRow {
    #[serde(rename = "positionId")]
    pub position_id: String,
    #[serde(rename = "marketId", skip_serializing_if = "Option::is_none")]
    pub market_id: Option<String>,
    #[serde(rename = "eventId", skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(rename = "conditionId", skip_serializing_if = "Option::is_none")]
    pub condition_id: Option<String>,
    #[serde(rename = "tokenId")]
    pub token_id: String,
    #[serde(rename = "outcomeLabel", skip_serializing_if = "Option::is_none")]
    pub outcome_label: Option<String>,
    pub shares: f64,
    #[serde(rename = "costUsdc")]
    pub cost_usdc: f64,
    #[serde(rename = "avgEntryPrice")]
    pub avg_entry_price: f64,
    #[serde(rename = "highWaterMark")]
    pub high_water_mark: f64,
    #[serde(rename = "stopTrailPct")]
    pub stop_trail_pct: f64,
    #[serde(rename = "closeReason")]
    pub close_reason: String,
    #[serde(rename = "orderId", skip_serializing_if = "Option::is_none")]
    pub order_id: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub paper: bool,
    #[serde(rename = "lastBid", skip_serializing_if = "Option::is_none")]
    pub last_bid: Option<f64>,
    #[serde(rename = "lastMid", skip_serializing_if = "Option::is_none")]
    pub last_mid: Option<f64>,
    #[serde(rename = "closedAt")]
    pub closed_at: String,
}
