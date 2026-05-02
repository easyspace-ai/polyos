use std::collections::HashMap;
use std::str::FromStr as _;

use alloy::primitives::Address;
use anyhow::Context;
use chrono::Utc;
use polymarket_client_sdk_v2::data::Client as DataClient;
use polymarket_client_sdk_v2::data::types::request::PositionsRequest;

use crate::accounts;
use crate::app::AppState;
use crate::models::{AccountRecord, Position};

pub struct SyncResult {
    pub synced_count: usize,
    pub created_count: usize,
    pub updated_count: usize,
    pub closed_count: usize,
}

/// Address used for Polymarket Data API `GET /positions` (`user` query): proxy wallet when set, else EOA.
pub fn data_api_query_address(acc: &AccountRecord) -> anyhow::Result<Address> {
    let addr_str = acc.proxy_wallet_address.trim();
    if !addr_str.is_empty() {
        Address::from_str(addr_str).context("proxy_wallet_address")
    } else {
        Address::from_str(acc.eoa_address.trim()).context("eoa_address")
    }
}

fn record_sync_error(app: &AppState, err: &str, user_hint: Option<&str>) {
    let mut st = app.chain_sync_status.lock();
    st.last_sync_at = Some(Utc::now().to_rfc3339());
    st.last_error = Some(err.to_string());
    if let Some(u) = user_hint {
        st.last_data_api_user = Some(u.to_string());
    }
}

/// Data API 的 `avg_price` 在 \[0,1\]；若像「美分」一样 >1 则换算。
fn normalize_prob_price(raw: f64) -> f64 {
    if raw > 1.01 { raw / 100.0 } else { raw }
}

/// Polymarket Data API 有时 `initial_value` / `avg_price` / `total_bought` 全缺或为零；
/// 仍可从 `current_value` 与 `cash_pnl`（未实现盈亏，USDC）反推成本：cost ≈ current − cash_pnl。
fn pct_as_fraction(raw: f64) -> f64 {
    if raw.abs() > 1.0 { raw / 100.0 } else { raw }
}

/// `initial_value` 有时为 0；用份额×均价、`total_bought`、市值与盈亏字段兜底。
fn cost_basis_from_chain(
    chain_pos: &polymarket_client_sdk_v2::data::types::response::Position,
    shares: f64,
) -> (f64, f64) {
    let avg_raw: f64 = chain_pos.avg_price.to_string().parse().unwrap_or(0.0);
    let avg = normalize_prob_price(avg_raw);
    let mut cost: f64 = chain_pos.initial_value.to_string().parse().unwrap_or(0.0);
    let total_bought: f64 = chain_pos.total_bought.to_string().parse().unwrap_or(0.0);
    let current_val: f64 = chain_pos.current_value.to_string().parse().unwrap_or(0.0);
    let cash_pnl: f64 = chain_pos.cash_pnl.to_string().parse().unwrap_or(0.0);
    let pct_pnl_raw: f64 = chain_pos.percent_pnl.to_string().parse().unwrap_or(0.0);

    if cost <= 0.0 && shares > 0.0 && avg > 0.0 {
        cost = shares * avg;
    }
    if cost <= 0.0 && total_bought > 0.0 {
        cost = total_bought;
    }
    // 兜底 1：市值 − 未实现盈亏 → 成本（与 Polymarket 持仓面板常见口径一致）
    if cost <= 1e-9 && shares > 0.0 && current_val > 1e-9 {
        let inferred = current_val - cash_pnl;
        if inferred > 1e-6 {
            cost = inferred;
        }
    }
    // 兜底 2：用百分比反推 cost = current / (1 + pct)
    if cost <= 1e-9 && shares > 0.0 && current_val > 1e-9 {
        let pct = pct_as_fraction(pct_pnl_raw);
        if pct > -0.999 && pct < 100.0 {
            let denom = 1.0 + pct;
            if denom.abs() > 1e-9 {
                let inferred = current_val / denom;
                if inferred > 1e-6 {
                    cost = inferred;
                }
            }
        }
    }
    // 兜底 3：仅有现价时用份额×现价作 USDC 成本近似（均价展示用，PnL 可能略偏）
    if cost <= 1e-9 && shares > 0.0 {
        let cur_raw: f64 = chain_pos.cur_price.to_string().parse().unwrap_or(0.0);
        let cur = normalize_prob_price(cur_raw);
        if cur > 1e-9 {
            cost = (shares * cur).max(0.0);
        }
    }

    let avg_out = if avg > 0.0 {
        avg
    } else if shares > 0.0 && cost > 1e-9 {
        (cost / shares).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (cost.max(0.0), avg_out)
}

fn record_sync_success(
    app: &AppState,
    result: &SyncResult,
    data_api_user: &str,
    chain_positions_len: usize,
) {
    let mut st = app.chain_sync_status.lock();
    st.last_sync_at = Some(Utc::now().to_rfc3339());
    st.last_error = None;
    st.last_data_api_user = Some(data_api_user.to_string());
    st.last_chain_positions_count = chain_positions_len;
    st.synced_count = result.synced_count;
    st.created_count = result.created_count;
    st.updated_count = result.updated_count;
    st.closed_count = result.closed_count;
}

/// If stored proxy differs from CREATE2 Polymarket Safe for this EVM key, Data API may return no rows.
fn warn_proxy_mismatch_if_any(acc: &AccountRecord) {
    let stored = acc.proxy_wallet_address.trim();
    if stored.is_empty() {
        return;
    }
    let Ok(expected) = accounts::expected_proxy_wallet_hex(&acc.evm_private_key) else {
        return;
    };
    if stored.eq_ignore_ascii_case(&expected) {
        return;
    }
    tracing::warn!(
        stored_proxy = %stored,
        derived_safe = %expected,
        "proxy_wallet_address differs from CREATE2-derived Safe; chain positions query may use wrong address — use POST /api/accounts/<accountId>/sync-derived-proxy"
    );
}

/// Sync on-chain positions from Polymarket Data API into local PositionStore.
/// - Creates new local records for external positions not yet tracked.
/// - Updates shares for existing positions if they changed on-chain.
/// - Closes local records for positions that disappeared or are redeemable on-chain.
pub async fn sync_chain_positions(app: &AppState) -> anyhow::Result<SyncResult> {
    let Some(acc) = app.default_account().await else {
        return Ok(SyncResult {
            synced_count: 0,
            created_count: 0,
            updated_count: 0,
            closed_count: 0,
        });
    };

    let addr = data_api_query_address(&acc).map_err(|e| {
        record_sync_error(app, &format!("address: {e}"), None);
        e
    })?;
    let user_hex = format!("{addr:#x}");
    warn_proxy_mismatch_if_any(&acc);

    let dc = DataClient::default();
    let chain_positions = dc
        .positions(
            &PositionsRequest::builder()
                .user(addr)
                .limit(200)
                .map_err(|e| anyhow::anyhow!(e.to_string()))?
                .build(),
        )
        .await
        .map_err(|e| {
            let msg = format!("Data API positions: {e}");
            record_sync_error(app, &msg, Some(&user_hex));
            anyhow::anyhow!(msg)
        })?;

    tracing::info!(
        %user_hex,
        proxy_field_non_empty = !acc.proxy_wallet_address.trim().is_empty(),
        positions_returned = chain_positions.len(),
        "chain sync: fetched Data API positions"
    );

    let global_params = app.global_params.get().await;

    // Build map: token_id -> chain position
    let mut chain_by_token: HashMap<
        String,
        polymarket_client_sdk_v2::data::types::response::Position,
    > = HashMap::new();
    for p in chain_positions {
        let tid = p.asset.to_string();
        if !tid.is_empty() {
            chain_by_token.insert(tid, p);
        }
    }

    let mut created = 0usize;
    let mut updated = 0usize;
    let mut closed = 0usize;

    // 1. Create or update positions that exist on-chain
    for (tid, chain_pos) in &chain_by_token {
        let shares: f64 = chain_pos.size.to_string().parse().unwrap_or(0.0);

        // If redeemable or zero shares, treat as closed（含本系统登记的仓位：在官网卖光后 Data API 仍会带一行 size=0）
        if chain_pos.redeemable || shares <= 0.0 {
            if let Some(local) = find_open_by_token(app, tid) {
                if !local.paper {
                    let snap = local.clone();
                    app.positions.update(&local.id, |x| {
                        x.state = "closed".into();
                        x.monitoring_active = false;
                    });
                    app.record_history_closed(&snap, "chain_closed", None, 0.0, 0.0)
                        .await;
                    closed += 1;
                }
            }
            continue;
        }

        if let Some(local) = find_open_by_token(app, tid) {
            // Existing position：同步份额，并回填 Data API 常缺的成本/均价
            let new_shares: f64 = chain_pos.size.to_string().parse().unwrap_or(local.shares);
            let (cost, avg) = cost_basis_from_chain(chain_pos, new_shares);
            let shares_changed = (new_shares - local.shares).abs() > 1e-6;
            let fill_cost = local.cost_usdc <= 0.0 && cost > 0.0;
            let fill_avg = local.avg_entry_price <= 0.0 && avg > 0.0;
            if shares_changed || fill_cost || fill_avg {
                app.positions.update(&local.id, |x| {
                    x.shares = new_shares;
                    if fill_cost {
                        x.cost_usdc = cost;
                    }
                    if fill_avg {
                        x.avg_entry_price = avg;
                    }
                });
                updated += 1;
            }
        } else {
            // New external position
            let new_shares: f64 = chain_pos.size.to_string().parse().unwrap_or(0.0);
            let (cost_usdc, avg_price) = cost_basis_from_chain(chain_pos, new_shares);
            let cur_raw: f64 = chain_pos.cur_price.to_string().parse().unwrap_or(avg_price);
            let cur_price = normalize_prob_price(cur_raw);
            let condition_id = format!("{:#x}", chain_pos.condition_id);
            let event_id = chain_pos.event_id.clone();
            let now = Utc::now().to_rfc3339();

            let stop_trail =
                (global_params.external_default_stop_loss_pct / 100.0).clamp(0.0, 0.99);

            let pos = Position {
                id: uuid::Uuid::new_v4().simple().to_string(),
                market_id: condition_id.clone(),
                condition_id: Some(condition_id),
                event_id,
                token_id: tid.clone(),
                shares: new_shares,
                avg_entry_price: avg_price,
                cost_usdc,
                stop_trail_pct: stop_trail,
                outcome_label: Some(chain_pos.outcome.clone()).filter(|s| !s.is_empty()),
                state: "open".into(),
                high_water_mark: cur_price.max(avg_price),
                monitoring_active: true,
                paper: false,
                external: true,
                auto_registered: true,
                game_start_at: None,
                created_at: now.clone(),
                updated_at: now,
            };
            app.positions.upsert(pos);
            created += 1;
        }
    }

    // 2. 本地仍 open 但 Data API 已无该 token（卖光后部分账户不再返回行）：非模拟盘一律关仓
    for local in app.positions.list_all() {
        if local.state != "open" || local.paper {
            continue;
        }
        if chain_by_token.contains_key(&local.token_id) {
            continue;
        }
        let snap = local.clone();
        app.positions.update(&local.id, |x| {
            x.state = "closed".into();
            x.monitoring_active = false;
        });
        app.record_history_closed(&snap, "chain_closed", None, 0.0, 0.0)
            .await;
        closed += 1;
    }

    let total = created + updated + closed;
    if total > 0 {
        tracing::info!(created, updated, closed, "chain sync completed");
    }

    let result = SyncResult {
        synced_count: total,
        created_count: created,
        updated_count: updated,
        closed_count: closed,
    };

    record_sync_success(app, &result, &user_hex, chain_by_token.len());

    Ok(result)
}

fn find_open_by_token(app: &AppState, token_id: &str) -> Option<Position> {
    app.positions
        .list_open()
        .into_iter()
        .find(|p| p.token_id == token_id)
}
