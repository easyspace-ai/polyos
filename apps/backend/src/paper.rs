use anyhow::Context;
use polymarket_client_sdk_v2::gamma::Client as GammaClient;
use polymarket_client_sdk_v2::gamma::types::request::EventBySlugRequest;
use url::Url;

use crate::models::{
    PaperOutcomeRef, PaperResolveResponse, PaperResolvedMarket, PaperSimulateBuyRequest, Position,
};
use crate::positions_store::PositionStore;

pub fn event_slug_from_url(raw: &str) -> anyhow::Result<String> {
    let s = raw.trim();
    let u = Url::parse(s).context("invalid url")?;
    if u.host_str().unwrap_or("").trim_start_matches("www.") != "polymarket.com" {
        anyhow::bail!("url host must be polymarket.com");
    }
    let segs: Vec<&str> = u
        .path()
        .trim_matches('/')
        .split('/')
        .filter(|x| !x.is_empty())
        .collect();
    for i in 0..segs.len().saturating_sub(1) {
        if segs[i] == "event" {
            if let Some(slug) = segs.get(i + 1) {
                return Ok((*slug).to_string());
            }
        }
    }
    if segs.len() >= 2 && segs[0] == "sports" {
        if let Some(last) = segs.last() {
            return Ok((*last).to_string());
        }
    }
    anyhow::bail!("path must be /event/{{slug}} or /sports/.../{{slug}}")
}

fn gamma_tokens(
    m: &polymarket_client_sdk_v2::gamma::types::response::Market,
) -> Vec<(String, String)> {
    let ids = m
        .clob_token_ids
        .as_ref()
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let outcomes = m.outcomes.as_deref().unwrap_or(&[]);
    let mut out = vec![];
    for (i, tid) in ids.iter().enumerate() {
        let s = tid.to_string();
        if s.is_empty() {
            continue;
        }
        let oc = outcomes.get(i).cloned().unwrap_or_default();
        out.push((s, oc));
    }
    out
}

pub async fn paper_resolve(
    gamma: &GammaClient,
    page_url: &str,
) -> anyhow::Result<PaperResolveResponse> {
    let slug = event_slug_from_url(page_url)?;
    let ev = gamma
        .event_by_slug(&EventBySlugRequest::builder().slug(slug.clone()).build())
        .await
        .context("event not found")?;
    let mut markets = vec![];
    for m in ev.markets.as_deref().unwrap_or(&[]) {
        let toks = gamma_tokens(m);
        if toks.is_empty() {
            continue;
        }
        let outcomes: Vec<PaperOutcomeRef> = toks
            .into_iter()
            .map(|(token_id, outcome)| PaperOutcomeRef { token_id, outcome })
            .collect();
        if outcomes.is_empty() {
            continue;
        }
        markets.push(PaperResolvedMarket {
            market_id: m.id.clone(),
            question: m.question.clone().unwrap_or_default(),
            outcomes,
        });
    }
    if markets.is_empty() {
        anyhow::bail!("event has no markets with CLOB tokens");
    }
    Ok(PaperResolveResponse {
        slug: ev.slug.unwrap_or(slug),
        event_id: ev.id,
        title: ev.title.unwrap_or_default(),
        markets,
    })
}

pub async fn paper_simulate_buy(
    pos: &PositionStore,
    req: &PaperSimulateBuyRequest,
) -> anyhow::Result<Position> {
    let mid = 0.5_f64;
    let shares = if mid > 0.0 { req.usdc / mid } else { 0.0 };
    let p = Position {
        id: String::new(),
        market_id: req.market_id.clone(),
        condition_id: None,
        event_id: req.event_id.clone(),
        token_id: req.token_id.clone(),
        shares,
        avg_entry_price: mid,
        cost_usdc: req.usdc,
        stop_trail_pct: req.stop_trail_pct,
        outcome_label: None,
        state: "open".into(),
        high_water_mark: mid,
        monitoring_active: req.arm,
        paper: true,
        external: false,
        auto_registered: false,
        game_start_at: None,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let p = pos.upsert(p);
    Ok(p)
}
