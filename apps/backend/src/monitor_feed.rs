use std::collections::HashSet;
use std::str::FromStr as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use futures::StreamExt as _;
use polymarket_client_sdk_v2::auth::Credentials;
use polymarket_client_sdk_v2::clob::ws::Client as WsClobClient;
use polymarket_client_sdk_v2::clob::ws::types::response::{BookUpdate, WsMessage};
use polymarket_client_sdk_v2::types::{Address as PolyAddress, Decimal, U256};
use polymarket_client_sdk_v2::ws::config::Config as WsConnConfig;
use uuid::Uuid;

use crate::app::AppState;
use crate::chain_sync;
use crate::risk_engine::Tick;
use crate::trading::TradingService;

pub static MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

static LAST_MIDPOINT_FALLBACK_UNIX_SEC: AtomicU64 = AtomicU64::new(0);

fn midpoint_fallback_throttle_ready() -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let prev = LAST_MIDPOINT_FALLBACK_UNIX_SEC.load(Ordering::Relaxed);
    if now.saturating_sub(prev) < 10 {
        return false;
    }
    LAST_MIDPOINT_FALLBACK_UNIX_SEC.store(now, Ordering::Relaxed);
    true
}

async fn maybe_midpoint_fallback(app: &Arc<AppState>) {
    if !midpoint_fallback_throttle_ready() {
        return;
    }
    let tokens = app.merged_price_tokens().await;
    if tokens.is_empty() {
        return;
    }
    match TradingService::fetch_public_midpoint_ticks(&tokens).await {
        Ok(ticks) => {
            tracing::info!(n = ticks.len(), "CLOB REST midpoints fallback (WS gap)");
            app.apply_price_ticks(ticks).await;
        }
        Err(e) => tracing::debug!(error = %e, "midpoint REST fallback skipped"),
    }
}

pub fn spawn_close_queue_loop(app: Arc<AppState>) {
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(5));
        loop {
            t.tick().await;
            let changed = app.process_close_queue().await;
            if changed {
                let snap = app.prices.build_snapshot(&app.positions);
                if let Ok(v) = serde_json::to_value(&snap) {
                    app.broadcast_monitor(v);
                }
            }
        }
    });
}

fn clob_ws_endpoint() -> String {
    std::env::var("CLOB_WS_URL")
        .unwrap_or_else(|_| "wss://ws-subscriptions-clob.polymarket.com".into())
}

fn decimal_to_f64(d: &Decimal) -> f64 {
    d.to_string().parse::<f64>().unwrap_or(0.0)
}

fn truncate_token_id(s: &str) -> String {
    let t = s.trim();
    if t.len() <= 14 {
        return t.to_string();
    }
    format!("{}…", &t[..12])
}

fn log_clob_user_ws_message(msg: &WsMessage) {
    match msg {
        WsMessage::Trade(t) => {
            tracing::info!(
                kind = "trade",
                trade_id = %t.id,
                status = ?t.status,
                side = ?t.side,
                size = %t.size,
                price = %t.price,
                asset_id = %truncate_token_id(&t.asset_id.to_string()),
                "CLOB user WebSocket event"
            );
        }
        WsMessage::Order(o) => {
            tracing::info!(
                kind = "order",
                order_id = %o.id,
                msg_type = ?o.msg_type,
                side = ?o.side,
                price = %o.price,
                original_size = ?o.original_size.as_ref().map(|d| d.to_string()),
                size_matched = ?o.size_matched.as_ref().map(|d| d.to_string()),
                asset_id = %truncate_token_id(&o.asset_id.to_string()),
                "CLOB user WebSocket event"
            );
        }
        other => {
            tracing::trace!(?other, "CLOB user WebSocket non-user message");
        }
    }
}

fn book_update_to_tick(book: &BookUpdate) -> Option<Tick> {
    let bid = decimal_to_f64(&book.bids.first()?.price);
    let ask = decimal_to_f64(&book.asks.first()?.price);
    if bid <= 0.0 || ask <= 0.0 {
        return None;
    }
    let mid = (bid + ask) / 2.0;
    Some(Tick {
        token_id: book.asset_id.to_string(),
        bid,
        ask,
        mid,
    })
}

/// Drives [`AppState::apply_price_ticks`] from **CLOB market WebSocket** order book updates
/// (`subscribe_orderbook`), not HTTP polling. Re-subscribes when the merged token set changes.
pub fn start_price_poll(app: Arc<AppState>) -> anyhow::Result<()> {
    if MONITOR_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    tokio::spawn(clob_orderbook_ws_loop(app));
    Ok(())
}

async fn clob_orderbook_ws_loop(app: Arc<AppState>) {
    let endpoint = clob_ws_endpoint();
    tracing::info!(%endpoint, "monitor CLOB price feed: WebSocket orderbook");

    while MONITOR_RUNNING.load(Ordering::SeqCst) {
        let token_strs = app.merged_price_tokens().await;
        let asset_ids: Vec<U256> = token_strs
            .iter()
            .filter_map(|s| U256::from_str(s.trim()).ok())
            .collect();

        if asset_ids.is_empty() {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }

        let snapshot_keys: HashSet<String> = token_strs.iter().cloned().collect();

        let ws = match WsClobClient::new(endpoint.trim(), WsConnConfig::default()) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "CLOB WS client create failed");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        let stream = match ws.subscribe_orderbook(asset_ids.clone()) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(
                    error = %e,
                    n = asset_ids.len(),
                    "CLOB WS subscribe_orderbook failed"
                );
                maybe_midpoint_fallback(&app).await;
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        let mut stream = Box::pin(stream);
        tracing::info!(n = asset_ids.len(), "CLOB WS subscribed (orderbook)");

        let mut inner = true;
        while inner && MONITOR_RUNNING.load(Ordering::SeqCst) {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    // Even when WS is healthy, some markets can stay quiet.
                    // Periodic midpoint fallback keeps risk marks/high-water updated.
                    maybe_midpoint_fallback(&app).await;
                    let now = app.merged_price_tokens().await;
                    let now_keys: HashSet<String> = now.iter().cloned().collect();
                    if now_keys != snapshot_keys {
                        tracing::info!(
                            old = snapshot_keys.len(),
                            new = now_keys.len(),
                            "CLOB WS token set changed, resubscribing"
                        );
                        break;
                    }
                }
                msg = stream.next() => {
                    match msg {
                        Some(Ok(book)) => {
                            if let Some(tick) = book_update_to_tick(&book) {
                                app.apply_price_ticks(vec![tick]).await;
                            }
                        }
                        Some(Err(e)) => {
                            tracing::warn!(error = %e, "CLOB WS orderbook message error");
                            inner = false;
                            maybe_midpoint_fallback(&app).await;
                        }
                        None => {
                            tracing::warn!("CLOB WS orderbook stream ended");
                            inner = false;
                            maybe_midpoint_fallback(&app).await;
                        }
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    tracing::info!("monitor CLOB price feed stopped");
}

pub fn stop_price_poll() {
    MONITOR_RUNNING.store(false, Ordering::SeqCst);
}

/// Periodically sync on-chain positions from Polymarket Data API into local PositionStore.
/// Runs every 30 seconds so external positions (placed outside this system) are tracked
/// and monitored for trailing-stop exits.
pub fn spawn_chain_sync_loop(app: Arc<AppState>) {
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(30));
        loop {
            t.tick().await;
            match chain_sync::sync_chain_positions(&app).await {
                Ok(res) => {
                    if res.synced_count > 0 {
                        tracing::info!(
                            created = res.created_count,
                            updated = res.updated_count,
                            closed = res.closed_count,
                            "chain sync: positions synced"
                        );
                        app.push_monitor_snapshot();
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "chain sync failed");
                }
            }
        }
    });
}

/// 最近一次因 CLOB user 事件触发链上同步的时间（毫秒），用于合并突发消息。
static LAST_USER_EVENT_CHAIN_SYNC_MS: AtomicU64 = AtomicU64::new(0);

async fn chain_sync_after_user_clob_event(app: &Arc<AppState>) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let prev = LAST_USER_EVENT_CHAIN_SYNC_MS.load(Ordering::Relaxed);
    if now_ms.saturating_sub(prev) < 900 {
        tracing::debug!("CLOB user chain_sync skipped (throttle)");
        return;
    }
    LAST_USER_EVENT_CHAIN_SYNC_MS.store(now_ms, Ordering::Relaxed);
    match chain_sync::sync_chain_positions(app).await {
        Ok(res) => {
            tracing::info!(
                synced = res.synced_count,
                created = res.created_count,
                updated = res.updated_count,
                closed = res.closed_count,
                "chain sync after CLOB user WebSocket event"
            );
            app.push_monitor_snapshot();
        }
        Err(e) => tracing::warn!(error = %e, "chain sync after CLOB user WS event failed"),
    }
}

/// Polymarket [User Channel](https://docs.polymarket.com/market-data/websocket/user-channel)：
/// 默认账户具备 CLOB API 凭证时，在后端订阅 `orders` + `trades`，成交/订单变化后立即拉 Data API 持仓并广播 `/ws/monitor`。
pub fn spawn_clob_user_events_loop(app: Arc<AppState>) {
    tokio::spawn(async move {
        while MONITOR_RUNNING.load(Ordering::SeqCst) {
            let Some(acc) = app.default_account().await else {
                tokio::time::sleep(Duration::from_secs(10)).await;
                continue;
            };
            if !acc.has_clob_credentials() {
                tracing::info!(
                    "CLOB user WebSocket disabled: default account missing apiKey/apiSecret/apiPassphrase (derive L2 creds once trading is set up)"
                );
                tokio::time::sleep(Duration::from_secs(120)).await;
                continue;
            }
            let key = match Uuid::parse_str(acc.api_key.trim()) {
                Ok(k) => k,
                Err(e) => {
                    tracing::warn!(error = %e, "CLOB user WS: api_key must be a UUID");
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    continue;
                }
            };
            let creds = Credentials::new(
                key,
                acc.api_secret.trim().to_string(),
                acc.api_passphrase.trim().to_string(),
            );
            let addr_hex = if acc.proxy_wallet_address.trim().is_empty() {
                acc.eoa_address.trim()
            } else {
                acc.proxy_wallet_address.trim()
            };
            let addr = match PolyAddress::from_str(addr_hex) {
                Ok(a) => a,
                Err(e) => {
                    tracing::warn!(error = %e, %addr_hex, "CLOB user WS: invalid wallet address");
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                }
            };
            let client = match WsClobClient::new(clob_ws_endpoint().trim(), WsConnConfig::default())
            {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(error = %e, "CLOB user WS: client create failed");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            let authed = match client.authenticate(creds, addr) {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(error = %e, "CLOB user WS: authenticate failed");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    continue;
                }
            };
            let stream = match authed.subscribe_user_events(vec![]) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!(error = %e, "CLOB user WS: subscribe_user_events failed");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            let mut stream = Box::pin(stream);
            tracing::info!("CLOB user WebSocket connected (type=user, markets=all)");

            while MONITOR_RUNNING.load(Ordering::SeqCst) {
                match stream.next().await {
                    Some(Ok(msg)) => {
                        log_clob_user_ws_message(&msg);
                        if msg.is_user() {
                            chain_sync_after_user_clob_event(&app).await;
                        }
                    }
                    Some(Err(e)) => {
                        tracing::warn!(error = %e, "CLOB user WS stream error");
                        break;
                    }
                    None => {
                        tracing::warn!("CLOB user WS stream ended");
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        tracing::info!("CLOB user WebSocket loop stopped");
    });
}
