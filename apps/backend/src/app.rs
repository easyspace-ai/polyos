use std::sync::Arc;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex as ParkingLotMutex;
use tokio::sync::{Mutex, broadcast};

use crate::accounts::AccountStore;
use crate::board::BoardDeps;
use crate::config::Config;
use crate::global_params::GlobalParamsStore;
use crate::history_db::HistoryDb;
use crate::models::{
    AccountRecord, ApiHomeMarketsResponse, HomeMarketItem, HomeMarketsData, LeagueConfig, Position,
};
use crate::positions_store::PositionStore;
use crate::risk_engine::{PriceBook, Tick, trailing_stop_triggered};
use crate::trading::TradingService;

#[derive(Debug, Clone, Default)]
pub struct ChainSyncStatus {
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    /// Checksummed hex used for the last successful Data API `positions` query.
    pub last_data_api_user: Option<String>,
    pub last_chain_positions_count: usize,
    pub synced_count: usize,
    pub created_count: usize,
    pub updated_count: usize,
    pub closed_count: usize,
}

pub struct AppState {
    pub cfg: Config,
    pub global_params: Arc<GlobalParamsStore>,
    pub leagues: Vec<LeagueConfig>,
    pub board: Arc<BoardDeps>,
    pub positions: Arc<PositionStore>,
    pub accounts: Arc<AccountStore>,
    pub trading: Arc<TradingService>,
    pub history: Option<Arc<HistoryDb>>,
    pub prices: Arc<PriceBook>,
    pub monitor_broadcast: broadcast::Sender<serde_json::Value>,
    pub board_broadcast: broadcast::Sender<serde_json::Value>,
    /// Per WebSocket connection subscription sets; union used for price polling.
    pub board_regs: Arc<Mutex<HashMap<u64, Vec<String>>>>,
    pub chain_sync_status: Arc<ParkingLotMutex<ChainSyncStatus>>,
    pub home_markets_cache: Arc<HomeMarketsCache>,
    pub monitor_last_broadcast_at: ParkingLotMutex<Option<Instant>>,
}

#[derive(Clone)]
pub struct CachedHomeMarkets {
    pub markets: Vec<HomeMarketItem>,
    pub timestamp: String,
    pub fetched_at: Instant,
}

pub struct HomeMarketsCache {
    cache: Mutex<HashMap<String, CachedHomeMarkets>>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl HomeMarketsCache {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
        }
    }

    pub async fn lock_for(&self, key: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        locks
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn get_fresh(&self, key: &str, ttl: Duration) -> Option<CachedHomeMarkets> {
        let cache = self.cache.lock().await;
        cache
            .get(key)
            .filter(|entry| entry.fetched_at.elapsed() <= ttl)
            .cloned()
    }

    pub async fn get_stale(&self, key: &str) -> Option<CachedHomeMarkets> {
        self.cache.lock().await.get(key).cloned()
    }

    pub async fn store(&self, key: String, markets: Vec<HomeMarketItem>) -> CachedHomeMarkets {
        let entry = CachedHomeMarkets {
            markets,
            timestamp: chrono::Utc::now().to_rfc3339(),
            fetched_at: Instant::now(),
        };
        self.cache.lock().await.insert(key, entry.clone());
        entry
    }
}

impl Default for HomeMarketsCache {
    fn default() -> Self {
        Self::new()
    }
}

impl CachedHomeMarkets {
    pub fn into_response(self, cached: bool) -> ApiHomeMarketsResponse {
        ApiHomeMarketsResponse {
            success: true,
            data: HomeMarketsData {
                markets: self.markets,
            },
            timestamp: self.timestamp,
            cached,
        }
    }
}

impl AppState {
    pub async fn board_union_tokens(&self) -> Vec<String> {
        let g = self.board_regs.lock().await;
        let mut u: Vec<String> = g.values().flatten().cloned().collect();
        u.sort();
        u.dedup();
        u
    }

    pub async fn merged_price_tokens(&self) -> Vec<String> {
        let pos: Vec<String> = self
            .positions
            .list_for_price_feed()
            .into_iter()
            .map(|p| p.token_id)
            .filter(|t| !t.trim().is_empty())
            .collect();
        let close_toks: Vec<String> = self
            .positions
            .list_close_tasks_ready()
            .into_iter()
            .filter_map(|ct| self.positions.get(&ct.position_id))
            .filter(|p| p.state == "open")
            .map(|p| p.token_id)
            .filter(|t| !t.trim().is_empty())
            .collect();
        let mut all: Vec<String> = pos.into_iter().chain(close_toks).collect();
        all.sort();
        all.dedup();
        all
    }

    pub async fn default_account(&self) -> Option<AccountRecord> {
        self.accounts.default_record()
    }

    pub fn broadcast_monitor(&self, v: serde_json::Value) {
        if tracing::enabled!(tracing::Level::TRACE) {
            let bytes = serde_json::to_string(&v).map(|s| s.len()).unwrap_or(0);
            tracing::trace!(payload_bytes = bytes, "monitor broadcast");
        }
        let _ = self.monitor_broadcast.send(v);
    }

    fn monitor_broadcast_ready(&self) -> bool {
        let debounce_ms = self.positions.risk_config().min_tick_debounce_ms.max(0) as u64;
        if debounce_ms == 0 {
            return true;
        }
        let mut last = self.monitor_last_broadcast_at.lock();
        let now = Instant::now();
        if let Some(prev) = *last
            && now.duration_since(prev) < Duration::from_millis(debounce_ms)
        {
            return false;
        }
        *last = Some(now);
        true
    }

    /// 将当前持仓 + 行情快照推送给所有 `/ws/monitor` 客户端（不依赖 CLOB 盘口 tick）。
    pub fn push_monitor_snapshot(&self) {
        let snap = self.prices.build_snapshot(&self.positions);
        if let Ok(v) = serde_json::to_value(&snap) {
            self.broadcast_monitor(v);
        }
    }

    pub fn broadcast_board_ticks(&self, quotes: serde_json::Map<String, serde_json::Value>) {
        let payload = serde_json::json!({
            "type": "ticks",
            "quotes": quotes,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });
        let _ = self.board_broadcast.send(payload);
    }

    pub async fn record_history_closed(
        &self,
        p: &Position,
        reason: &str,
        order_id: Option<&str>,
        last_bid: f64,
        last_mid: f64,
    ) {
        let Some(h) = &self.history else {
            return;
        };
        let _ = h
            .record_closed(
                &p.id,
                Some(p.market_id.as_str()),
                p.event_id.as_deref(),
                p.condition_id.as_deref(),
                &p.token_id,
                p.outcome_label.as_deref(),
                p.shares,
                p.cost_usdc,
                p.avg_entry_price,
                p.high_water_mark,
                p.stop_trail_pct,
                reason,
                order_id,
                p.paper,
                last_bid,
                last_mid,
                &chrono::Utc::now().to_rfc3339(),
            )
            .await;
    }

    /// Returns true if close tasks or positions were mutated (caller may broadcast monitor snapshot).
    pub async fn process_close_queue(&self) -> bool {
        let Some(acc) = self.default_account().await else {
            return false;
        };
        let mut changed = false;
        let tasks = self.positions.list_close_tasks_ready();
        for task in tasks {
            let Some(ref_pos) = self.positions.get(&task.position_id) else {
                self.positions
                    .remove_close_task(&task.position_id, &task.kind);
                changed = true;
                continue;
            };
            if ref_pos.shares <= 0.0 || ref_pos.token_id.trim().is_empty() {
                self.positions
                    .remove_close_task(&task.position_id, &task.kind);
                changed = true;
                continue;
            }
            if task.kind != "trail_stop" || ref_pos.state != "open" {
                self.positions
                    .remove_close_task(&task.position_id, &task.kind);
                changed = true;
                continue;
            }
            let tid = ref_pos.token_id.clone();
            let sh = ref_pos.shares;
            let paper = ref_pos.paper;
            let pid = ref_pos.id.clone();
            match self.trading.market_sell_shares(&acc, &tid, sh, paper).await {
                Ok(resp) => {
                    let order_id = resp
                        .get("orderID")
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                    let tick = self.prices.get(&tid).unwrap_or_default();
                    let snap = ref_pos.clone();
                    let _ = self.positions.update(&pid, |x| {
                        x.state = "stopped_out".into();
                        x.monitoring_active = false;
                    });
                    self.positions.remove_close_task(&pid, "trail_stop");
                    self.record_history_closed(
                        &snap,
                        "trail_stop",
                        order_id.as_deref(),
                        tick.bid,
                        tick.mid,
                    )
                    .await;
                    changed = true;
                    tracing::info!(
                        position_id = %pid,
                        token_id = %tid,
                        order_id = ?order_id,
                        "risk close queue: retry close executed successfully"
                    );
                }
                Err(e) => {
                    self.positions
                        .record_close_failure(&pid, "trail_stop", &e.to_string());
                    changed = true;
                    tracing::error!(
                        position_id = %pid,
                        token_id = %tid,
                        error = %e,
                        "risk close queue: retry close failed"
                    );
                }
            }
        }
        changed
    }

    pub async fn evaluate_trailing_stops(&self) {
        let Some(acc) = self.default_account().await else {
            return;
        };
        let open = self.positions.list_open();
        for p in open {
            if p.state != "open" || !p.monitoring_active {
                continue;
            }
            let Some(tick) = self.prices.get(&p.token_id) else {
                continue;
            };
            if tick.mid <= 0.0 {
                continue;
            }
            let _ = self.positions.update(&p.id, |x| {
                if tick.mid > x.high_water_mark || x.high_water_mark <= 0.0 {
                    x.high_water_mark = tick.mid;
                }
            });
            let Some(ref_pos) = self.positions.get(&p.id) else {
                continue;
            };
            if tick.bid <= 0.0 {
                continue;
            }
            if !trailing_stop_triggered(ref_pos.high_water_mark, tick.bid, ref_pos.stop_trail_pct) {
                continue;
            }
            tracing::info!(
                position_id = %ref_pos.id,
                token_id = %ref_pos.token_id,
                high_water_mark = ref_pos.high_water_mark,
                stop_trail_pct = ref_pos.stop_trail_pct,
                trigger_bid = tick.bid,
                trigger_mid = tick.mid,
                stop_price = ref_pos.high_water_mark * (1.0 - ref_pos.stop_trail_pct),
                "risk trail: trigger condition met, submitting close"
            );
            if self
                .positions
                .has_pending_close_task(&ref_pos.id, "trail_stop")
            {
                continue;
            }
            let key = format!("risk-trail-{}", ref_pos.id);
            if !self.positions.try_claim_risk_key(&key) {
                continue;
            }
            let snap = ref_pos.clone();
            let res = self
                .trading
                .market_sell_shares(&acc, &snap.token_id, snap.shares, snap.paper)
                .await;
            match res {
                Ok(resp) => {
                    let order_id = resp
                        .get("orderID")
                        .and_then(|x| x.as_str())
                        .map(str::to_string);
                    let _ = self.positions.update(&snap.id, |x| {
                        x.state = "stopped_out".into();
                        x.monitoring_active = false;
                    });
                    self.positions.release_risk_key(&key);
                    self.record_history_closed(
                        &snap,
                        "trail_stop",
                        order_id.as_deref(),
                        tick.bid,
                        tick.mid,
                    )
                    .await;
                    tracing::info!(
                        position_id = %snap.id,
                        token_id = %snap.token_id,
                        order_id = ?order_id,
                        "risk trail: close executed successfully"
                    );
                }
                Err(e) => {
                    self.positions.release_risk_key(&key);
                    self.positions
                        .record_close_failure(&snap.id, "trail_stop", &e.to_string());
                    tracing::error!(
                        position_id = %snap.id,
                        token_id = %snap.token_id,
                        error = %e,
                        "risk trail: close execution failed"
                    );
                }
            }
        }
    }

    pub async fn apply_price_ticks(&self, ticks: Vec<Tick>) {
        for t in &ticks {
            self.prices.set_tick(t.clone());
        }
        self.process_close_queue().await;
        self.evaluate_trailing_stops().await;
        if self.monitor_broadcast_ready() {
            let snap = self.prices.build_snapshot(&self.positions);
            if let Ok(v) = serde_json::to_value(&snap) {
                self.broadcast_monitor(v);
            }
        }
        let mut quotes = serde_json::Map::new();
        for t in ticks {
            if let Ok(q) = serde_json::to_value(crate::models::Quote {
                token_id: t.token_id.clone(),
                midpoint: t.mid,
                best_bid: t.bid,
                best_ask: t.ask,
            }) {
                quotes.insert(t.token_id, q);
            }
        }
        if !quotes.is_empty() {
            self.broadcast_board_ticks(quotes);
        }
    }
}
