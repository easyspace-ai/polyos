use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use futures::StreamExt;
use serde::Deserialize;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::accounts::account_view;
use crate::app::AppState;
use crate::board;
use crate::chain_sync;
use crate::global_params::GlobalParams;
use crate::models::*;
use crate::monitor_feed::{self, MONITOR_RUNNING};
use crate::paper;
use crate::positions_store::{RiskPatch, new_position_from_register};

static NEXT_BOARD_CONN: AtomicU64 = AtomicU64::new(1);

pub fn router(app: Arc<AppState>) -> Router {
    let web_dir = app.cfg.web_dir();
    let index_file = web_dir.join("index.html");
    let web_service = ServeDir::new(web_dir).not_found_service(ServeFile::new(index_file));

    Router::new()
        .route("/health", get(health))
        .route("/api/runtime-status", get(get_runtime_status))
        .route(
            "/api/settings/global-params",
            get(get_global_params).put(put_global_params),
        )
        .route("/api/leagues", get(get_leagues))
        .route("/api/home/markets", get(get_home_markets))
        .route("/api/home/ticks", post(post_home_ticks))
        .route(
            "/api/markets/resolve-by-clob-tokens",
            get(resolve_by_clob_tokens),
        )
        .route("/api/history/closed", get(history_closed))
        .route("/api/accounts", get(list_accounts).post(create_account))
        .route("/api/accounts/reload-auth", post(reload_auth))
        .route(
            "/api/accounts/{id}/sync-derived-proxy",
            post(sync_derived_proxy),
        )
        .route("/api/accounts/{id}", delete(delete_account))
        .route("/api/accounts/{id}/default", post(set_default_account))
        .route("/orders", post(place_order))
        .route("/orders/{id}", get(get_order))
        .route("/trading/market-sell", post(market_sell))
        .route("/trading/close-all", post(close_all))
        .route("/trading/orders", get(list_orders))
        .route("/trading/trades", get(list_trades))
        .route("/positions", get(list_positions).post(register_position))
        .route("/positions/reconcile", get(reconcile))
        .route("/positions/chain", get(chain_positions))
        .route("/positions/chain-sync", post(post_chain_sync))
        .route("/positions/chain-sync/status", get(get_chain_sync_status))
        .route("/positions/{id}", patch(patch_position))
        .route("/positions/{id}/arm", post(arm_position))
        .route("/positions/{id}/disarm", post(disarm_position))
        .route("/positions/{id}/close", post(close_position))
        .route("/risk/config", patch(patch_risk))
        .route("/monitor/start", post(monitor_start))
        .route("/monitor/stop", post(monitor_stop))
        .route("/monitor/snapshot", get(monitor_snapshot))
        .route("/monitor/close-tasks", get(close_tasks))
        .route("/paper/resolve", post(paper_resolve_h))
        .route("/paper/simulate-buy", post(paper_simulate_buy_h))
        .route("/ws/board", get(ws_board))
        .route("/ws/monitor", get(ws_monitor))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods([
                    axum::http::Method::GET,
                    axum::http::Method::POST,
                    axum::http::Method::PATCH,
                    axum::http::Method::PUT,
                    axum::http::Method::OPTIONS,
                ])
                .allow_headers([
                    axum::http::header::CONTENT_TYPE,
                    axum::http::HeaderName::from_static("idempotency-key"),
                ]),
        )
        .layer(TraceLayer::new_for_http())
        .fallback_service(web_service)
        .with_state(app)
}

async fn get_global_params(State(app): State<Arc<AppState>>) -> Json<GlobalParams> {
    Json(app.global_params.get().await)
}

async fn put_global_params(
    State(app): State<Arc<AppState>>,
    Json(body): Json<GlobalParams>,
) -> Result<Json<GlobalParams>, (StatusCode, String)> {
    app.global_params
        .set(body.clone())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(body))
}

async fn health(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let st = app.chain_sync_status.lock();
    Json(serde_json::json!({
        "status": "ok",
        "monitor": {"running": MONITOR_RUNNING.load(Ordering::SeqCst)},
        "chainSync": {
            "lastSyncAt": st.last_sync_at,
            "lastError": st.last_error,
        }
    }))
}

async fn get_runtime_status(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let st = app.chain_sync_status.lock();
    let open_positions = app.positions.list_open().len();
    Json(serde_json::json!({
        "monitorWsRunning": MONITOR_RUNNING.load(Ordering::SeqCst),
        "lastChainSyncAt": st.last_sync_at,
        "lastChainSyncError": st.last_error,
        "lastDataApiUser": st.last_data_api_user,
        "lastChainPositionsCount": st.last_chain_positions_count,
        "openPositionsCount": open_positions,
        "lastPriceTickAt": app.prices.last_tick_at(),
    }))
}

async fn get_leagues(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({ "leagues": app.leagues }))
}

#[derive(Deserialize)]
struct HomeMarketsQuery {
    league: Option<String>,
    date: Option<String>,
    status: Option<String>,
    tz_offset: Option<i32>,
}

async fn get_home_markets(
    State(app): State<Arc<AppState>>,
    Query(q): Query<HomeMarketsQuery>,
) -> Result<Json<ApiHomeMarketsResponse>, (StatusCode, String)> {
    let league = q.league.unwrap_or_else(|| "NBA".into());
    let date = q.date.unwrap_or_default();
    let status = q.status.unwrap_or_else(|| "active".into());
    let tz = q.tz_offset.unwrap_or(0);
    let cache_key = format!("league={league}|date={date}|status={status}|tz={tz}");
    let ttl = std::time::Duration::from_secs(45);
    if let Some(entry) = app.home_markets_cache.get_fresh(&cache_key, ttl).await {
        return Ok(Json(entry.into_response(true)));
    }

    let key_lock = app.home_markets_cache.lock_for(&cache_key).await;
    let _guard = key_lock.lock().await;
    if let Some(entry) = app.home_markets_cache.get_fresh(&cache_key, ttl).await {
        return Ok(Json(entry.into_response(true)));
    }

    let fetched = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        app.board
            .fetch_home_markets(&app.leagues, &league, &date, &status, tz),
    )
    .await;

    match fetched {
        Ok(Ok(markets)) => {
            let entry = app.home_markets_cache.store(cache_key, markets).await;
            Ok(Json(entry.into_response(false)))
        }
        Ok(Err(e)) => {
            if let Some(entry) = app.home_markets_cache.get_stale(&cache_key).await {
                tracing::warn!(error = %e, %league, "home markets fetch failed, serving stale cache");
                Ok(Json(entry.into_response(true)))
            } else {
                Err((StatusCode::BAD_GATEWAY, e.to_string()))
            }
        }
        Err(_) => {
            if let Some(entry) = app.home_markets_cache.get_stale(&cache_key).await {
                tracing::warn!(%league, "home markets fetch timed out, serving stale cache");
                Ok(Json(entry.into_response(true)))
            } else {
                Err((StatusCode::GATEWAY_TIMEOUT, "markets fetch timeout".into()))
            }
        }
    }
}

async fn post_home_ticks(
    State(app): State<Arc<AppState>>,
    Json(body): Json<HomeTicksBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let ids: Vec<String> = body
        .token_ids
        .iter()
        .take(160)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let batch = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        app.board.batch_quote_tokens(&ids),
    )
    .await
    .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "quote timeout".into()))?;
    let mut quotes = serde_json::Map::new();
    for tid in ids {
        if let Some((mid, bb, ba, _, _)) = batch.get(&tid).copied() {
            if let Ok(v) = serde_json::to_value(Quote {
                token_id: tid.clone(),
                midpoint: mid,
                best_bid: bb,
                best_ask: ba,
            }) {
                quotes.insert(tid, v);
            }
        }
    }
    Ok(Json(serde_json::Value::Object(
        [("quotes".to_string(), serde_json::Value::Object(quotes))]
            .into_iter()
            .collect(),
    )))
}

#[derive(Deserialize)]
struct ResolveTokensQuery {
    token: Vec<String>,
}

async fn resolve_by_clob_tokens(
    State(app): State<Arc<AppState>>,
    Query(q): Query<ResolveTokensQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let mut uniq: Vec<String> = vec![];
    for t in q.token {
        let t = t.trim().to_string();
        if !t.is_empty() && !uniq.contains(&t) {
            uniq.push(t);
        }
        if uniq.len() >= 80 {
            break;
        }
    }
    let m = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        board::resolve_tokens_meta(&app.board.gamma, &uniq),
    )
    .await
    .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "token resolve timeout".into()))?
    .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok(Json(serde_json::json!({ "markets": m })))
}

async fn history_closed(
    State(app): State<Arc<AppState>>,
    Query(l): Query<LimitQ>,
) -> impl IntoResponse {
    let limit = l.limit.unwrap_or(120).clamp(1, 500);
    let Some(h) = &app.history else {
        return Json(serde_json::json!({ "rows": []})).into_response();
    };
    match h.list_recent(limit).await {
        Ok(rows) => Json(serde_json::json!({ "rows": rows })).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct LimitQ {
    limit: Option<i64>,
}

async fn list_accounts(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let (def, recs) = app.accounts.snapshot();
    let futures: Vec<_> = recs
        .into_iter()
        .map(|r| {
            let trading = app.trading.clone();
            tokio::spawn(async move {
                let (bal, note) = match trading.clob_balance_usdc(&r).await {
                    Ok(x) => x,
                    Err(_) => (0.0, "CLOB unavailable".into()),
                };
                let port = trading.portfolio_value(&r).await.unwrap_or(0.0);
                (r, bal, port, note)
            })
        })
        .collect();
    let mut views = vec![];
    for handle in futures {
        if let Ok((r, bal, port, note)) = handle.await {
            views.push(account_view(
                &r,
                &def,
                bal,
                port,
                &note,
                r.has_clob_credentials(),
            ));
        }
    }
    Json(AccountsListResponse {
        default_id: def,
        accounts: views,
    })
}

async fn create_account(
    State(app): State<Arc<AppState>>,
    Json(req): Json<CreateAccountRequest>,
) -> Response {
    let rec =
        match crate::accounts::derive_account_record_with_clob(req.label, &req.evm_private_key)
            .await
        {
            Ok(r) => r,
            Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
        };
    let saved = match app.accounts.add(rec).await {
        Ok(s) => s,
        Err(e) => return (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    };
    if saved
        .proxy_wallet_address
        .trim()
        .eq_ignore_ascii_case(saved.eoa_address.trim())
    {
        tracing::warn!(
            account_id = %saved.id,
            "proxy_wallet_address equals EOA; Polymarket Data API may return no positions until a Safe proxy is available"
        );
    }
    let (def, _) = app.accounts.snapshot();
    let (bal, note) = app
        .trading
        .clob_balance_usdc(&saved)
        .await
        .unwrap_or((0.0, String::new()));
    let port = app.trading.portfolio_value(&saved).await.unwrap_or(0.0);
    Json(account_view(
        &saved,
        &def,
        bal,
        port,
        &note,
        saved.has_clob_credentials(),
    ))
    .into_response()
}

async fn delete_account(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    match app.accounts.remove(&id).await {
        Ok(()) => Json(serde_json::json!({"ok": true})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

async fn set_default_account(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    match app.accounts.set_default(&id).await {
        Ok(()) => Json(serde_json::json!({"ok": true, "defaultId": id})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e.to_string()).into_response(),
    }
}

async fn reload_auth(State(_app): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({"ok": true}))
}

async fn sync_derived_proxy(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<AccountView>, (StatusCode, String)> {
    let saved = app
        .accounts
        .sync_derived_proxy_for_account(&id)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    let (def, _) = app.accounts.snapshot();
    let (bal, note) = app
        .trading
        .clob_balance_usdc(&saved)
        .await
        .unwrap_or((0.0, String::new()));
    let port = app.trading.portfolio_value(&saved).await.unwrap_or(0.0);
    Ok(Json(account_view(
        &saved,
        &def,
        bal,
        port,
        &note,
        saved.has_clob_credentials(),
    )))
}

async fn place_order(
    State(app): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<PlaceOrderRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let acc = app
        .default_account()
        .await
        .ok_or((StatusCode::BAD_REQUEST, "no default account".into()))?;
    let idem = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let v = app
        .trading
        .place_order(&acc, &req, idem.as_deref())
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(v))
}

async fn get_order(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let acc = app
        .default_account()
        .await
        .ok_or((StatusCode::BAD_REQUEST, "no default account".into()))?;
    let v = app
        .trading
        .get_order_json(&acc, &id)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(v))
}

async fn market_sell(
    State(app): State<Arc<AppState>>,
    Json(req): Json<MarketSellRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let acc = app
        .default_account()
        .await
        .ok_or((StatusCode::BAD_REQUEST, "no default account".into()))?;
    let v = app
        .trading
        .market_sell_shares(&acc, &req.token_id, req.shares, req.dry_run)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(v))
}

async fn close_all(
    State(app): State<Arc<AppState>>,
    Json(req): Json<CloseAllTradingRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let acc = app
        .default_account()
        .await
        .ok_or((StatusCode::BAD_REQUEST, "no default account".into()))?;
    app.trading
        .cancel_all_orders(&acc)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, e.to_string()))?;
    let sells = req.sells.unwrap_or_default();
    let mut results = vec![];
    for leg in sells {
        match app
            .trading
            .market_sell_shares(&acc, &leg.token_id, leg.shares, false)
            .await
        {
            Ok(r) => results.push(serde_json::json!({"tokenId": leg.token_id, "order": r})),
            Err(e) => {
                results.push(serde_json::json!({"tokenId": leg.token_id, "error": e.to_string()}))
            }
        }
    }
    Ok(Json(serde_json::json!({ "results": results })))
}

async fn list_orders(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let Some(acc) = app.default_account().await else {
        return (StatusCode::BAD_REQUEST, "no account").into_response();
    };
    match app.trading.list_orders_json(&acc).await {
        Ok(j) => Json(j).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "http /trading/orders failed");
            (StatusCode::BAD_GATEWAY, e.to_string()).into_response()
        }
    }
}

async fn list_trades(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let Some(acc) = app.default_account().await else {
        return (StatusCode::BAD_REQUEST, "no account").into_response();
    };
    match app.trading.list_trades_json(&acc).await {
        Ok(j) => Json(j).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "http /trading/trades failed");
            (StatusCode::BAD_GATEWAY, e.to_string()).into_response()
        }
    }
}

async fn list_positions(
    State(app): State<Arc<AppState>>,
    Query(q): Query<PaperFilter>,
) -> Json<Vec<Position>> {
    let mut all = app.positions.list_all();
    if let Some(true) = q.paper {
        all.retain(|p| p.paper);
    } else if let Some(false) = q.paper {
        all.retain(|p| !p.paper);
    }
    Json(all)
}

#[derive(Deserialize)]
struct PaperFilter {
    paper: Option<bool>,
}

async fn register_position(
    State(app): State<Arc<AppState>>,
    Json(req): Json<RegisterPositionRequest>,
) -> Result<Json<Position>, (StatusCode, String)> {
    if req.market_id.trim().is_empty()
        || req.token_id.trim().is_empty()
        || req.shares <= 0.0
        || req.cost_usdc <= 0.0
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "marketId, tokenId, shares, and costUsdc are required".into(),
        ));
    }
    let trail = app.positions.risk_config().default_stop_trail_pct;
    tracing::info!(
        market_id = %req.market_id,
        token_id = %req.token_id,
        shares = req.shares,
        cost_usdc = req.cost_usdc,
        paper = req.paper,
        default_trail = trail,
        "http /positions register requested"
    );
    let p = new_position_from_register(&req, trail);
    let p = app.positions.upsert(p);
    tracing::info!(
        position_id = %p.id,
        market_id = %p.market_id,
        token_id = %p.token_id,
        stop_trail_pct = p.stop_trail_pct,
        monitoring_active = p.monitoring_active,
        "http /positions register completed"
    );
    let _ = monitor_feed::start_price_poll(app.clone());
    Ok(Json(p))
}

async fn arm_position(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Position>, (StatusCode, String)> {
    let Some(p) = app.positions.update(&id, |x| x.monitoring_active = true) else {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    };
    Ok(Json(p))
}

async fn disarm_position(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Position>, (StatusCode, String)> {
    let Some(p) = app.positions.update(&id, |x| x.monitoring_active = false) else {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    };
    Ok(Json(p))
}

async fn close_position(State(app): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(p) = app.positions.get(&id) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    tracing::info!(
        position_id = %id,
        token_id = %p.token_id,
        shares = p.shares,
        state = %p.state,
        paper = p.paper,
        "http /positions/{id}/close requested"
    );

    // If still open, perform on-chain sell first so the position is actually closed.
    if p.state == "open" && p.shares > 0.0 && !p.token_id.trim().is_empty() {
        let Some(acc) = app.default_account().await else {
            return (StatusCode::BAD_REQUEST, "no default account").into_response();
        };
        match app
            .trading
            .market_sell_shares(&acc, &p.token_id, p.shares, p.paper)
            .await
        {
            Ok(resp) => {
                let order_id = resp
                    .get("orderID")
                    .and_then(|x| x.as_str())
                    .map(str::to_string);
                let making_amount = resp
                    .get("makingAmount")
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);
                let taking_amount = resp
                    .get("takingAmount")
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);
                let exec_px = if making_amount > 0.0 && taking_amount > 0.0 {
                    (taking_amount / making_amount).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                let snap = p.clone();
                app.positions.update(&id, |x| {
                    x.state = "manual_closed".into();
                    x.monitoring_active = false;
                });
                app.record_history_closed(
                    &snap,
                    "manual_close",
                    order_id.as_deref(),
                    exec_px,
                    exec_px,
                )
                .await;
                tracing::info!(
                    position_id = %id,
                    token_id = %p.token_id,
                    order_id = ?order_id,
                    exec_price = exec_px,
                    making_amount,
                    taking_amount,
                    "http /positions/{id}/close completed (sold then closed)"
                );
                return Json(serde_json::json!({"ok": true})).into_response();
            }
            Err(e) => {
                tracing::error!(
                    position_id = %id,
                    token_id = %p.token_id,
                    error = %e,
                    "http /positions/{id}/close sell failed"
                );
                return (StatusCode::BAD_GATEWAY, format!("sell failed: {}", e)).into_response();
            }
        }
    }

    let snap = p.clone();
    app.positions.update(&id, |x| {
        x.state = "manual_closed".into();
        x.monitoring_active = false;
    });
    app.record_history_closed(&snap, "manual_close", None, 0.0, 0.0)
        .await;
    tracing::info!(
        position_id = %id,
        token_id = %p.token_id,
        "http /positions/{id}/close completed (state closed without sell)"
    );
    StatusCode::OK.into_response()
}

async fn post_chain_sync(State(app): State<Arc<AppState>>) -> Response {
    match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        crate::chain_sync::sync_chain_positions(&app),
    )
    .await
    {
        Ok(Ok(res)) => Json(serde_json::json!({
            "ok": true,
            "syncedCount": res.synced_count,
            "createdCount": res.created_count,
            "updatedCount": res.updated_count,
            "closedCount": res.closed_count,
        }))
        .into_response(),
        Ok(Err(e)) => {
            tracing::error!(error = %e, "http /positions/chain-sync failed");
            (StatusCode::BAD_GATEWAY, format!("sync failed: {}", e)).into_response()
        }
        Err(_) => {
            tracing::error!("http /positions/chain-sync timeout");
            (StatusCode::GATEWAY_TIMEOUT, "sync timeout".to_string()).into_response()
        }
    }
}

async fn get_chain_sync_status(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let st = app.chain_sync_status.lock();
    Json(serde_json::json!({
        "lastSyncAt": st.last_sync_at,
        "lastError": st.last_error,
        "lastDataApiUser": st.last_data_api_user,
        "lastChainPositionsCount": st.last_chain_positions_count,
        "syncedCount": st.synced_count,
        "createdCount": st.created_count,
        "updatedCount": st.updated_count,
        "closedCount": st.closed_count,
        "externalOpenCount": app.positions.list_all().iter().filter(|p| p.external && p.state == "open").count(),
    }))
}

#[derive(Deserialize)]
struct PatchPositionBody {
    stop_trail_pct: Option<f64>,
    monitoring_active: Option<bool>,
}

async fn patch_position(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(b): Json<PatchPositionBody>,
) -> Result<Json<crate::models::Position>, (StatusCode, String)> {
    let Some(mut p) = app.positions.get(&id) else {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    };
    if let Some(v) = b.stop_trail_pct {
        p.stop_trail_pct = v;
    }
    if let Some(v) = b.monitoring_active {
        p.monitoring_active = v;
    }
    app.positions.upsert(p.clone());
    Ok(Json(p))
}

#[derive(Deserialize)]
struct RiskPatchBody {
    default_stop_trail_pct: Option<f64>,
    min_tick_debounce_ms: Option<i32>,
}

async fn patch_risk(
    State(app): State<Arc<AppState>>,
    Json(b): Json<RiskPatchBody>,
) -> Json<RiskConfig> {
    let cfg = app.positions.set_risk_config(RiskPatch {
        default_stop_trail_pct: b.default_stop_trail_pct,
        min_tick_debounce_ms: b.min_tick_debounce_ms,
    });
    Json(cfg)
}

async fn monitor_start(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let _ = monitor_feed::start_price_poll(app);
    Json(serde_json::json!({"ok": true}))
}

async fn monitor_stop() -> impl IntoResponse {
    monitor_feed::stop_price_poll();
    Json(serde_json::json!({"ok": true}))
}

async fn monitor_snapshot(State(app): State<Arc<AppState>>) -> Json<MonitorSnapshot> {
    Json(app.prices.build_snapshot(&app.positions))
}

async fn close_tasks(State(app): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let tasks = app.positions.list_close_tasks();
    Json(serde_json::json!({ "tasks": tasks }))
}

async fn paper_resolve_h(
    State(app): State<Arc<AppState>>,
    Json(req): Json<PaperResolveRequest>,
) -> Result<Json<PaperResolveResponse>, (StatusCode, String)> {
    let out = paper::paper_resolve(&app.board.gamma, &req.url)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(out))
}

async fn paper_simulate_buy_h(
    State(app): State<Arc<AppState>>,
    Json(req): Json<PaperSimulateBuyRequest>,
) -> Result<Json<Position>, (StatusCode, String)> {
    let p = paper::paper_simulate_buy(&app.positions, &req)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;
    Ok(Json(p))
}

async fn reconcile(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let proxy = app
        .accounts
        .default_record()
        .map(|a| {
            if !a.proxy_wallet_address.trim().is_empty() {
                a.proxy_wallet_address.clone()
            } else {
                a.eoa_address.clone()
            }
        })
        .unwrap_or_default();
    let Some(acc) = app.default_account().await else {
        return Json(ReconcileResponse {
            proxy,
            rows: vec![],
        })
        .into_response();
    };
    let chain = match chain_positions_inner(&app, &acc).await {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_GATEWAY, e).into_response(),
    };
    let chain_by: HashMap<String, f64> = chain
        .iter()
        .filter_map(|o| {
            let tid = o.get("asset")?.as_str()?.to_string();
            let sz = o.get("size")?.as_f64()?;
            Some((tid, sz))
        })
        .collect();
    let eps = 1e-4_f64;
    let mut locals: HashMap<String, crate::models::Position> = HashMap::new();
    for p in app.positions.list_open() {
        if p.paper {
            continue;
        }
        let tid = p.token_id.trim().to_string();
        if tid.is_empty() {
            continue;
        }
        locals.insert(tid.clone(), p);
    }
    let mut rows = vec![];
    let mut matched = std::collections::HashSet::new();
    for (tid, p) in &locals {
        if let Some(cs) = chain_by.get(tid) {
            matched.insert(tid.clone());
            let drift = (p.shares - cs).abs() > eps;
            rows.push(ReconcileRow {
                token_id: tid.clone(),
                local_id: Some(p.id.clone()),
                market_id: Some(p.market_id.clone()),
                local_shares: p.shares,
                chain_shares: Some(*cs),
                drift,
                note: if drift {
                    Some("size_mismatch".into())
                } else {
                    None
                },
            });
        } else {
            rows.push(ReconcileRow {
                token_id: tid.clone(),
                local_id: Some(p.id.clone()),
                market_id: Some(p.market_id.clone()),
                local_shares: p.shares,
                chain_shares: None,
                drift: true,
                note: Some("missing_on_chain".into()),
            });
        }
    }
    for (tid, cs) in &chain_by {
        if matched.contains(tid) {
            continue;
        }
        rows.push(ReconcileRow {
            token_id: tid.clone(),
            local_id: None,
            market_id: None,
            local_shares: 0.0,
            chain_shares: Some(*cs),
            drift: true,
            note: Some("extra_on_chain".into()),
        });
    }
    Json(ReconcileResponse { proxy, rows }).into_response()
}

async fn chain_positions(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let Some(acc) = app.default_account().await else {
        return Json(Vec::<serde_json::Value>::new()).into_response();
    };
    match chain_positions_inner(&app, &acc).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, e).into_response(),
    }
}

async fn chain_positions_inner(
    _app: &AppState,
    acc: &crate::models::AccountRecord,
) -> Result<Vec<serde_json::Value>, String> {
    use polymarket_client_sdk_v2::data::Client as DataClient;
    use polymarket_client_sdk_v2::data::types::request::PositionsRequest;

    let addr = chain_sync::data_api_query_address(acc).map_err(|e| e.to_string())?;
    let dc = DataClient::default();
    let positions = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        dc.positions(
            &PositionsRequest::builder()
                .user(addr)
                .limit(200)
                .map_err(|e| e.to_string())?
                .build(),
        ),
    )
    .await
    .map_err(|_| "Data API positions timeout".to_string())?
    .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for p in positions {
        out.push(serde_json::json!({
            "asset": p.asset.to_string(),
            "size": p.size.to_string().parse::<f64>().unwrap_or(0.0),
        }));
    }
    Ok(out)
}

async fn ws_board(ws: WebSocketUpgrade, State(app): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| board_ws(socket, app))
}

async fn board_ws(mut socket: WebSocket, app: Arc<AppState>) {
    let cid = NEXT_BOARD_CONN.fetch_add(1, Ordering::SeqCst);
    let mut sub = app.board_broadcast.subscribe();
    if let Some(Ok(Message::Text(t))) = socket.next().await {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
            if let Some(arr) = v.get("tokenIds").and_then(|x| x.as_array()) {
                let ids: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect();
                app.board_regs.lock().await.insert(cid, ids);
            }
        }
    }
    loop {
        tokio::select! {
            m = sub.recv() => {
                match m {
                    Ok(v) => {
                        if let Ok(txt) = serde_json::to_string(&v) {
                            let _ = socket.send(Message::Text(txt.into())).await;
                        }
                    }
                    Err(_) => break,
                }
            }
            _ = socket.recv() => {
                break;
            }
        }
    }
    app.board_regs.lock().await.remove(&cid);
}

async fn ws_monitor(ws: WebSocketUpgrade, State(app): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| monitor_ws(socket, app))
}

async fn monitor_ws(mut socket: WebSocket, app: Arc<AppState>) {
    let mut sub = app.monitor_broadcast.subscribe();
    let snap = app.prices.build_snapshot(&app.positions);
    if let Ok(t) = serde_json::to_string(&snap) {
        let _ = socket.send(Message::Text(t.into())).await;
    }
    loop {
        tokio::select! {
            m = sub.recv() => {
                match m {
                    Ok(v) => {
                        if let Ok(txt) = serde_json::to_string(&v) {
                            let _ = socket.send(Message::Text(txt.into())).await;
                        }
                    }
                    Err(_) => break,
                }
            }
            _ = socket.recv() => break,
        }
    }
}
