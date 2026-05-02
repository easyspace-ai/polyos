use std::collections::HashMap;
use std::str::FromStr as _;

use alloy::primitives::U256;
use chrono::Utc;

use crate::models::{MonitorPositionRow, MonitorSnapshot, RiskConfig};
use crate::positions_store::PositionStore;

/// Normalize token id to decimal string so hex/decimal formats are interchangeable.
fn normalize_token_id(token_id: &str) -> String {
    let t = token_id.trim();
    if t.is_empty() {
        return String::new();
    }
    if let Ok(u) = U256::from_str(t) {
        u.to_string()
    } else {
        t.to_string()
    }
}

#[derive(Clone, Default, Debug)]
pub struct Tick {
    pub token_id: String,
    pub bid: f64,
    pub ask: f64,
    pub mid: f64,
}

pub fn trailing_stop_triggered(high_water: f64, bid: f64, trail_pct: f64) -> bool {
    if high_water <= 0.0 || bid <= 0.0 || trail_pct <= 0.0 || trail_pct >= 1.0 {
        return false;
    }
    bid <= high_water * (1.0 - trail_pct)
}

pub struct PriceBook {
    prices: parking_lot::RwLock<HashMap<String, Tick>>,
    last_tick_at: parking_lot::Mutex<Option<String>>,
}

impl PriceBook {
    pub fn new() -> Self {
        Self {
            prices: parking_lot::RwLock::new(HashMap::new()),
            last_tick_at: parking_lot::Mutex::new(None),
        }
    }

    pub fn last_tick_at(&self) -> Option<String> {
        self.last_tick_at.lock().clone()
    }

    pub fn set_tick(&self, t: Tick) {
        let key = normalize_token_id(&t.token_id);
        if !key.is_empty() {
            self.prices.write().insert(key, t);
            *self.last_tick_at.lock() = Some(Utc::now().to_rfc3339());
        }
    }

    pub fn get(&self, token_id: &str) -> Option<Tick> {
        let key = normalize_token_id(token_id);
        self.prices.read().get(&key).cloned()
    }

    pub fn build_snapshot(&self, positions: &PositionStore) -> MonitorSnapshot {
        let cfg = positions.risk_config();
        let all = positions.list_all();
        let px = self.prices.read().clone();
        let mut rows = vec![];
        let mut total_cost = 0.0f64;
        let mut total_bid = 0.0f64;
        let mut total_mid = 0.0f64;
        for p in all {
            total_cost += p.cost_usdc;
            let tk = px.get(&p.token_id);
            let (bid, ask, mid) = if let Some(t) = tk {
                let mut m = t.mid;
                if m <= 0.0 && t.bid > 0.0 && t.ask > 0.0 {
                    m = (t.bid + t.ask) / 2.0;
                }
                (Some(t.bid), Some(t.ask), Some(m))
            } else {
                (None, None, None)
            };
            let mid_v = mid.unwrap_or(0.0);
            let unreal = if p.shares > 0.0 && mid_v > 0.0 {
                p.shares * mid_v - p.cost_usdc
            } else {
                0.0
            };
            if let Some(b) = bid {
                total_bid += p.shares * b;
            }
            if mid_v > 0.0 {
                total_mid += p.shares * mid_v;
            }
            rows.push(MonitorPositionRow {
                id: p.id.clone(),
                market_id: p.market_id.clone(),
                event_id: p.event_id.clone(),
                token_id: p.token_id.clone(),
                shares: p.shares,
                cost_usdc: p.cost_usdc,
                stop_trail_pct: p.stop_trail_pct,
                outcome_label: p.outcome_label.clone(),
                state: p.state.clone(),
                monitoring_active: p.monitoring_active,
                high_water_mark: p.high_water_mark,
                bid,
                ask,
                mid,
                unrealized_mid_usdc: unreal,
                paper: p.paper,
            });
        }
        let unrealized_mid = total_mid - total_cost;
        let unrealized_pct = if total_cost > 0.0 {
            unrealized_mid / total_cost
        } else {
            0.0
        };
        MonitorSnapshot {
            total_cost_usdc: total_cost,
            total_mark_value_bid: total_bid,
            unrealized_mid_usdc: unrealized_mid,
            unrealized_pct_mid: unrealized_pct,
            positions: rows,
            risk: RiskConfig {
                default_stop_trail_pct: cfg.default_stop_trail_pct,
                min_tick_debounce_ms: cfg.min_tick_debounce_ms,
            },
            timestamp: Utc::now().to_rfc3339(),
        }
    }
}
