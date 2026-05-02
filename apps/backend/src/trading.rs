use std::str::FromStr as _;

use alloy::primitives::Address;
use alloy::signers::Signer as _;
use alloy::signers::local::PrivateKeySigner;
use anyhow::Context;
use dashmap::DashMap;
use polymarket_client_sdk_v2::auth::Credentials;
use polymarket_client_sdk_v2::clob::types::request::{
    BalanceAllowanceRequest, MidpointRequest, OrdersRequest, TradesRequest,
};
use polymarket_client_sdk_v2::clob::types::{Amount, AssetType, OrderType, Side, SignatureType};
use polymarket_client_sdk_v2::clob::{Client as ClobClient, Config as ClobConfig};
use polymarket_client_sdk_v2::data::Client as DataClient;
use polymarket_client_sdk_v2::data::types::request::PositionsRequest;
use polymarket_client_sdk_v2::types::Address as PolyAddress;
use polymarket_client_sdk_v2::types::Decimal;
use polymarket_client_sdk_v2::types::U256;
use polymarket_client_sdk_v2::{POLYGON, PRIVATE_KEY_VAR};
use rust_decimal_macros::dec;
use uuid::Uuid;

use crate::models::{AccountRecord, PlaceOrderRequest};

type AuthedClient = ClobClient<
    polymarket_client_sdk_v2::auth::state::Authenticated<polymarket_client_sdk_v2::auth::Normal>,
>;

/// CLOB collateral balance: integer strings are **micro-USDC** (6 decimals), same as Go
/// `ParseCollateralBalanceUSDC`.
fn parse_collateral_balance_usdc(d: &Decimal) -> f64 {
    let s = d.normalize().to_string();
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    if t.contains('.') || t.contains('e') || t.contains('E') {
        return t.parse::<f64>().unwrap_or(0.0);
    }
    if let Ok(i) = t.parse::<i64>() {
        return i as f64 / 1_000_000.0;
    }
    t.parse::<f64>().unwrap_or(0.0)
}

pub struct TradingService {
    idempotency: DashMap<String, serde_json::Value>,
    clob_cache: DashMap<String, (AuthedClient, PrivateKeySigner)>,
}

impl TradingService {
    pub fn new() -> Self {
        Self {
            idempotency: DashMap::new(),
            clob_cache: DashMap::new(),
        }
    }

    /// Unauthenticated CLOB batch midpoints — REST fallback when the orderbook WebSocket is down.
    pub async fn fetch_public_midpoint_ticks(
        token_ids: &[String],
    ) -> anyhow::Result<Vec<crate::risk_engine::Tick>> {
        let host = Self::clob_host();
        let client =
            ClobClient::new(host.as_str(), ClobConfig::default()).context("clob client")?;
        let mut reqs: Vec<MidpointRequest> = Vec::new();
        for s in token_ids {
            let Some(u) = U256::from_str(s.trim()).ok() else {
                continue;
            };
            reqs.push(MidpointRequest::builder().token_id(u).build());
        }
        anyhow::ensure!(!reqs.is_empty(), "no valid token ids for midpoints");
        let resp = client.midpoints(&reqs).await?;
        let mut out = Vec::new();
        for (asset, dec) in resp.midpoints {
            let mid = dec.to_string().parse::<f64>().unwrap_or(0.0);
            if mid <= 0.0 {
                continue;
            }
            let token_id = asset.to_string();
            out.push(crate::risk_engine::Tick {
                token_id,
                bid: mid,
                ask: mid,
                mid,
            });
        }
        anyhow::ensure!(!out.is_empty(), "midpoints response empty");
        Ok(out)
    }

    fn private_key(acc: &AccountRecord) -> String {
        std::env::var(PRIVATE_KEY_VAR)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| acc.evm_private_key.clone())
    }

    fn clob_host() -> String {
        std::env::var("CLOB_API_URL").unwrap_or_else(|_| "https://clob.polymarket.com".into())
    }

    async fn connect(
        &self,
        acc: &AccountRecord,
    ) -> anyhow::Result<(AuthedClient, PrivateKeySigner)> {
        if let Some(entry) = self.clob_cache.get(&acc.id) {
            let (client, signer) = entry.value();
            return Ok((client.clone(), signer.clone()));
        }
        let pk = Self::private_key(acc);
        let signer = PrivateKeySigner::from_str(pk.trim())
            .context("private key")?
            .with_chain_id(Some(POLYGON));
        let host = Self::clob_host();
        let mut auth = ClobClient::new(host.as_str(), ClobConfig::default())?
            .authentication_builder(&signer)
            .signature_type(SignatureType::GnosisSafe);
        let proxy = acc.proxy_wallet_address.trim();
        if !proxy.is_empty() {
            let funder = PolyAddress::from_str(proxy).context("proxy_address / funder")?;
            auth = auth.funder(funder);
        }
        if acc.has_clob_credentials() {
            let key = Uuid::parse_str(acc.api_key.trim()).context("api_key (UUID)")?;
            auth = auth.credentials(Credentials::new(
                key,
                acc.api_secret.trim().to_string(),
                acc.api_passphrase.trim().to_string(),
            ));
        }
        let client = auth.authenticate().await?;
        self.clob_cache
            .insert(acc.id.clone(), (client.clone(), signer.clone()));
        Ok((client, signer))
    }

    /// Evict cached client for an account (e.g., after auth errors).
    pub fn invalidate_clob_cache(&self, account_id: &str) {
        self.clob_cache.remove(account_id);
    }

    pub async fn place_order(
        &self,
        acc: &AccountRecord,
        req: &PlaceOrderRequest,
        idem: Option<&str>,
    ) -> anyhow::Result<serde_json::Value> {
        tracing::info!(
            account_id = %acc.id,
            token_id = %req.token_id,
            side = %req.side.as_deref().unwrap_or("BUY"),
            order_type = %req.order_type.as_deref().unwrap_or("FAK"),
            amount_usdc = req.amount_usdc,
            dry_run = req.dry_run,
            "trade open: place_order requested"
        );
        if let Some(k) = idem.filter(|s| !s.is_empty()) {
            if let Some(v) = self.idempotency.get(k) {
                tracing::info!(idempotency_key = %k, "trade open: idempotency hit");
                return Ok(v.clone());
            }
        }
        if req.token_id.trim().is_empty() {
            anyhow::bail!("tokenId is required");
        }
        if req.amount_usdc <= 0.0 {
            anyhow::bail!("amountUsdc must be > 0");
        }
        if req.dry_run {
            let v = serde_json::json!({
                "orderID": "dry-run",
                "status": "DRY_RUN",
                "success": true,
            });
            if let Some(k) = idem.filter(|s| !s.is_empty()) {
                self.idempotency.insert(k.to_string(), v.clone());
            }
            tracing::info!("trade open: dry-run order accepted");
            return Ok(v);
        }
        let (client, signer) = self.connect(acc).await?;
        let tid = U256::from_str(req.token_id.trim()).context("token id")?;
        let side = match req.side.as_deref().unwrap_or("BUY").to_uppercase().as_str() {
            "SELL" => Side::Sell,
            _ => Side::Buy,
        };
        let ot = match req
            .order_type
            .as_deref()
            .unwrap_or("FAK")
            .to_uppercase()
            .as_str()
        {
            "FOK" => OrderType::FOK,
            "GTC" => OrderType::GTC,
            _ => OrderType::FAK,
        };
        let amount_dec = Decimal::try_from(req.amount_usdc).unwrap_or(dec!(0));
        let amount = Amount::usdc(amount_dec).context("amount")?;
        let resp = client
            .market_order()
            .token_id(tid)
            .side(side)
            .amount(amount)
            .order_type(ot)
            .build_sign_and_post(&signer)
            .await?;
        tracing::info!(
            account_id = %acc.id,
            order_id = %resp.order_id,
            status = ?resp.status,
            success = resp.success,
            token_id = %req.token_id,
            "trade open: place_order completed"
        );
        let v = serde_json::json!({
            "orderID": resp.order_id,
            "status": format!("{:?}", resp.status),
            "success": resp.success,
            "errorMsg": resp.error_msg,
            "makingAmount": resp.making_amount.to_string(),
            "takingAmount": resp.taking_amount.to_string(),
        });
        if let Some(k) = idem.filter(|s| !s.is_empty()) {
            self.idempotency.insert(k.to_string(), v.clone());
        }
        Ok(v)
    }

    pub async fn market_sell_shares(
        &self,
        acc: &AccountRecord,
        token_id: &str,
        shares: f64,
        dry_run: bool,
    ) -> anyhow::Result<serde_json::Value> {
        tracing::info!(
            account_id = %acc.id,
            token_id = %token_id,
            shares,
            dry_run,
            "trade close: market_sell requested"
        );
        if dry_run {
            return Ok(serde_json::json!({
                "orderID": "dry-run-sell",
                "status": "DRY_RUN",
                "success": true,
            }));
        }
        let (client, signer) = self.connect(acc).await?;
        let tid = U256::from_str(token_id.trim()).context("token id")?;
        // CLOB v2 enforces lot-size precision for shares (2 dp).
        let raw_sh = Decimal::try_from(shares).unwrap_or(dec!(0));
        let sh = raw_sh.trunc_with_scale(2);
        if sh <= dec!(0) {
            anyhow::bail!(
                "shares invalid after v2 lot-size quantize: raw={} quantized={} (need >= 0.01)",
                raw_sh,
                sh
            );
        }
        let amount = Amount::shares(sh).map_err(|e| {
            anyhow::anyhow!(
                "shares invalid for v2 lot-size: raw={} quantized={} err={}",
                raw_sh,
                sh,
                e
            )
        })?;
        tracing::info!(
            account_id = %acc.id,
            token_id = %token_id,
            raw_shares = %raw_sh,
            quantized_shares = %sh,
            "trade close: shares quantized for v2 order"
        );
        let resp = client
            .market_order()
            .token_id(tid)
            .side(Side::Sell)
            .amount(amount)
            .order_type(OrderType::FAK)
            .build_sign_and_post(&signer)
            .await?;
        tracing::info!(
            account_id = %acc.id,
            order_id = %resp.order_id,
            status = ?resp.status,
            success = resp.success,
            token_id = %token_id,
            shares = %sh,
            "trade close: market_sell completed"
        );
        Ok(serde_json::json!({
            "orderID": resp.order_id,
            "status": format!("{:?}", resp.status),
            "success": resp.success,
            "makingAmount": resp.making_amount.to_string(),
            "takingAmount": resp.taking_amount.to_string(),
        }))
    }

    pub async fn get_order_json(
        &self,
        acc: &AccountRecord,
        order_id: &str,
    ) -> anyhow::Result<serde_json::Value> {
        let (client, _) = self.connect(acc).await?;
        let o = client.order(order_id).await?;
        Ok(serde_json::json!({
            "id": o.id,
            "status": format!("{:?}", o.status),
            "asset_id": o.asset_id.to_string(),
            "original_size": o.original_size.to_string(),
            "size_matched": o.size_matched.to_string(),
            "price": o.price.to_string(),
            "outcome": o.outcome,
        }))
    }

    pub async fn cancel_all_orders(&self, acc: &AccountRecord) -> anyhow::Result<()> {
        let (client, _) = self.connect(acc).await?;
        client.cancel_all_orders().await?;
        Ok(())
    }

    pub async fn list_orders_json(&self, acc: &AccountRecord) -> anyhow::Result<serde_json::Value> {
        let (client, _) = self.connect(acc).await?;
        let page = client
            .orders(&OrdersRequest::builder().build(), None::<String>)
            .await?;
        let data: Vec<serde_json::Value> = page
            .data
            .iter()
            .map(|o| {
                serde_json::json!({
                    "id": o.id,
                    "status": format!("{:?}", o.status),
                    "asset_id": o.asset_id.to_string(),
                    "original_size": o.original_size.to_string(),
                    "size_matched": o.size_matched.to_string(),
                    "price": o.price.to_string(),
                    "outcome": o.outcome,
                })
            })
            .collect();
        Ok(serde_json::json!({
            "data": data,
            "next_cursor": page.next_cursor,
        }))
    }

    pub async fn list_trades_json(&self, acc: &AccountRecord) -> anyhow::Result<serde_json::Value> {
        let (client, _) = self.connect(acc).await?;
        let page = client
            .trades(&TradesRequest::builder().build(), None::<String>)
            .await?;
        let data: Vec<serde_json::Value> = page
            .data
            .iter()
            .map(|t| {
                serde_json::json!({
                    "id": t.id,
                    "price": t.price.to_string(),
                    "size": t.size.to_string(),
                    "side": format!("{:?}", t.side),
                    "asset_id": t.asset_id.to_string(),
                })
            })
            .collect();
        Ok(serde_json::json!({
            "data": data,
            "next_cursor": page.next_cursor,
        }))
    }

    pub async fn clob_balance_usdc(&self, acc: &AccountRecord) -> anyhow::Result<(f64, String)> {
        let (client, _) = self.connect(acc).await?;
        let bal = client
            .balance_allowance(
                BalanceAllowanceRequest::builder()
                    .asset_type(AssetType::Collateral)
                    .build(),
            )
            .await?;
        let v = parse_collateral_balance_usdc(&bal.balance);
        Ok((v, "CLOB".into()))
    }

    pub async fn portfolio_value(&self, acc: &AccountRecord) -> anyhow::Result<f64> {
        let addr_str = acc.proxy_wallet_address.trim();
        let addr: Address = if !addr_str.is_empty() {
            Address::from_str(addr_str).context("proxy address")?
        } else {
            Address::from_str(acc.eoa_address.trim()).context("eoa address")?
        };
        let dc = DataClient::default();
        let positions = dc
            .positions(
                &PositionsRequest::builder()
                    .user(addr)
                    .limit(200)
                    .map_err(|e| anyhow::anyhow!(e.to_string()))?
                    .build(),
            )
            .await?;
        let mut sum = 0.0f64;
        for p in positions {
            sum += p.current_value.to_string().parse::<f64>().unwrap_or(0.0);
        }
        Ok(sum)
    }
}
