use std::collections::HashMap;

use anyhow::Context;
use chrono::{DateTime, Utc};
use polymarket_client_sdk_v2::clob::types::request::OrderBookSummaryRequest;
use polymarket_client_sdk_v2::clob::{Client as ClobClient, Config as ClobConfig};
use polymarket_client_sdk_v2::gamma::Client as GammaClient;
use polymarket_client_sdk_v2::gamma::types::request::{EventsRequest, MarketsRequest};
use polymarket_client_sdk_v2::types::Decimal;
use polymarket_client_sdk_v2::types::U256;
use std::str::FromStr as _;

use crate::events_feed::{self, NbaResolvedJob};
use crate::leagues;
use crate::models::{HomeMarketItem, LeagueConfig};

#[derive(Clone, Default)]
pub struct TeamMapping {
    pub chinese_name: String,
    pub polymarket_name: String,
    pub poly_keywords: Vec<String>,
    pub espn_abbr: String,
    pub espn_name: String,
}

pub async fn load_teams(path: &std::path::Path) -> Vec<TeamMapping> {
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return vec![];
    }
    let Ok(raw) = tokio::fs::read_to_string(path).await else {
        return vec![];
    };
    #[derive(serde::Deserialize)]
    struct Row {
        #[serde(default)]
        chinese_name: String,
        #[serde(default)]
        polymarket_name: String,
        #[serde(default)]
        poly_keywords: Vec<String>,
        #[serde(default)]
        espn_abbr: String,
        #[serde(default)]
        espn_name: String,
    }
    let Ok(rows): Result<Vec<Row>, _> = serde_json::from_str(&raw) else {
        return vec![];
    };
    rows.into_iter()
        .map(|r| TeamMapping {
            chinese_name: r.chinese_name,
            polymarket_name: r.polymarket_name,
            poly_keywords: r.poly_keywords,
            espn_abbr: r.espn_abbr,
            espn_name: r.espn_name,
        })
        .collect()
}

fn match_team<'a>(input: &str, teams: &'a [TeamMapping]) -> Option<&'a TeamMapping> {
    let n = input.to_lowercase();
    for t in teams {
        let mut cands = vec![
            t.espn_abbr.as_str(),
            t.espn_name.as_str(),
            t.chinese_name.as_str(),
            t.polymarket_name.as_str(),
        ];
        cands.extend(t.poly_keywords.iter().map(|s| s.as_str()));
        for c in cands {
            let k = c.to_lowercase();
            if k.is_empty() {
                continue;
            }
            if n == k || n.contains(&k) || k.contains(&n) {
                return Some(t);
            }
        }
    }
    None
}

fn chinese_line(title: &str, teams: &[TeamMapping]) -> String {
    let (away, home) = parse_event_sides(title);
    if away.is_empty() || home.is_empty() {
        return String::new();
    }
    let a = match_team(&away, teams)
        .map(|t| t.chinese_name.as_str())
        .unwrap_or(away.trim());
    let h = match_team(&home, teams)
        .map(|t| t.chinese_name.as_str())
        .unwrap_or(home.trim());
    format!("{a} vs {h}")
}

fn normalize_title(title: &str) -> String {
    let mut t = title.trim().to_string();
    for suf in [" NBA", " nba", " Nba"] {
        if t.ends_with(suf) {
            t.truncate(t.len() - suf.len());
        }
    }
    t.trim().to_string()
}

fn parse_event_sides(title: &str) -> (String, String) {
    let t = normalize_title(title);
    let low = t.to_lowercase();
    if let Some(idx) = low.find(" @ ") {
        return (t[..idx].trim().to_string(), t[idx + 3..].trim().to_string());
    }
    let sep = if low.contains(" vs. ") {
        " vs. "
    } else {
        " vs "
    };
    if let Some(idx) = t.find(sep) {
        return (
            t[..idx].trim().to_string(),
            t[idx + sep.len()..].trim().to_string(),
        );
    }
    (String::new(), String::new())
}

fn dec_to_f64(d: Option<Decimal>) -> f64 {
    d.and_then(|x| x.to_string().parse().ok()).unwrap_or(0.0)
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

fn parse_flexible_time(s: &str) -> Option<DateTime<Utc>> {
    let trim = s.trim();
    if trim.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(trim)
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .or_else(|| trim.parse::<DateTime<Utc>>().ok())
}

fn iso_to_local_ymd(iso: &str, tz_offset_min: i32) -> Option<String> {
    let t = parse_flexible_time(iso)?;
    let ms = t.timestamp_millis() - i64::from(tz_offset_min) * 60 * 1000;
    Some(
        chrono::DateTime::from_timestamp_millis(ms)?
            .date_naive()
            .to_string(),
    )
}

fn derive_status(start_iso: &str, end_iso: &str) -> String {
    let now = Utc::now();
    let Some(start) = parse_flexible_time(start_iso) else {
        return "PRE".into();
    };
    let mut end = start + chrono::Duration::hours(4);
    if !end_iso.is_empty() {
        if let Some(e) = parse_flexible_time(end_iso) {
            end = e;
        }
    }
    if now < start {
        "PRE".into()
    } else if now > end {
        "FINAL".into()
    } else {
        "LIVE".into()
    }
}

fn passes_status_filter(status: &str, filter: &str) -> bool {
    match filter.to_lowercase().trim() {
        "" | "active" => status == "PRE" || status == "LIVE",
        "live" => status == "LIVE",
        "all" => true,
        _ => true,
    }
}

fn is_real_matchup(active: bool, closed: bool, title: &str) -> bool {
    let t = title.to_lowercase();
    let fmt = t.contains(" vs ") || t.contains(" vs. ") || t.contains(" @ ");
    fmt && active && !closed
}

/// Polymarket「比赛」视图里的单场对阵；排除系列赛胜负、晋级等周/轮次型市场
/// （标题里常带 “vs”，会误过 `is_real_matchup`）。
fn is_series_or_non_single_game_event(title: &str, event_slug: &str) -> bool {
    let t = title.to_lowercase();
    let s = event_slug.to_lowercase();
    // 系列赛谁赢 / 赢系列赛 —— 与单场 moneyline 区分
    const TITLE_MARKERS: &[&str] = &[
        "who will win series",
        "will win series",
        "win the series",
        "to win the series",
        "wins the series",
        "win this series",
        "series winner",
        "which team will win the series",
        "win the nba finals series",
    ];
    for m in TITLE_MARKERS {
        if t.contains(m) {
            return true;
        }
    }
    // 标题同时强调 playoff + series 且带 “who will” 类措辞
    if t.contains("playoffs") && t.contains("series") && t.contains("who will") {
        return true;
    }
    // slug 常见系列赛命名
    if s.contains("series-winner")
        || s.contains("who-wins-series")
        || s.contains("win-series")
        || s.ends_with("-series")
    {
        return true;
    }
    false
}

fn is_primary_winner(q: &str, slug: &str) -> bool {
    let q = format!("{} {}", q.to_lowercase(), slug.to_lowercase());
    let excluded = [
        "spread", "total", "over", "under", "quarter", "1q", "2q", "3q", "4q", "half", "player",
    ];
    for ex in excluded {
        if q.contains(ex) && !q.contains("thunder") {
            return false;
        }
    }
    true
}

fn pick_moneyline<'a>(
    markets: &'a [polymarket_client_sdk_v2::gamma::types::response::Market],
) -> Option<&'a polymarket_client_sdk_v2::gamma::types::response::Market> {
    let mut fallback = None;
    for m in markets {
        let active = m.active.unwrap_or(false);
        let closed = m.closed.unwrap_or(false);
        if !active || closed {
            continue;
        }
        if m.market_type
            .as_deref()
            .map(|t| t.eq_ignore_ascii_case("moneyline"))
            .unwrap_or(false)
        {
            return Some(m);
        }
        let q = m.question.as_deref().unwrap_or("");
        let sl = m.slug.as_deref().unwrap_or("");
        if is_primary_winner(q, sl) {
            fallback = Some(m);
        }
    }
    fallback
}

fn game_tip_off_iso(
    ev: &polymarket_client_sdk_v2::gamma::types::response::Event,
    m: &polymarket_client_sdk_v2::gamma::types::response::Market,
) -> String {
    let poly = events_feed::polymarket_game_start_rfc3339(ev, m);
    if !poly.trim().is_empty() {
        return poly;
    }
    m.start_date
        .map(|d| d.to_rfc3339())
        .or_else(|| ev.start_date.map(|d| d.to_rfc3339()))
        .or_else(|| ev.end_date.map(|d| d.to_rfc3339()))
        .unwrap_or_default()
}

fn event_game_time_iso(ev: &polymarket_client_sdk_v2::gamma::types::response::Event) -> String {
    ev.start_date
        .map(|d| d.to_rfc3339())
        .or_else(|| ev.end_date.map(|d| d.to_rfc3339()))
        .unwrap_or_default()
}

fn derive_tier(mid: f64) -> Option<String> {
    if (0.05..=0.25).contains(&mid) {
        Some("A".into())
    } else if mid > 0.25 && mid <= 0.55 {
        Some("B".into())
    } else if mid > 0.55 && mid <= 0.85 {
        Some("C".into())
    } else {
        None
    }
}

fn gamma_tokens(
    m: &polymarket_client_sdk_v2::gamma::types::response::Market,
) -> Vec<(String, String, f64)> {
    let ids = m
        .clob_token_ids
        .as_ref()
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let outcomes = m.outcomes.as_deref().unwrap_or(&[]);
    let prices = m.outcome_prices.as_deref().unwrap_or(&[]);
    let mut out = vec![];
    for (i, tid) in ids.iter().enumerate() {
        let s = tid.to_string();
        if s.is_empty() {
            continue;
        }
        let oc = outcomes.get(i).cloned().unwrap_or_default();
        let pr = prices
            .get(i)
            .copied()
            .map(|d| dec_to_f64(Some(d)))
            .unwrap_or(0.0);
        out.push((s, oc, pr));
    }
    out
}

fn title_matches_league(title: &str, league: &str) -> bool {
    let t = title.to_lowercase();
    match league.to_lowercase().as_str() {
        "nba" => t.contains("nba"),
        "nhl" => t.contains("nhl"),
        "ncaab" | "ncaa" => {
            t.contains("ncaab") || t.contains("ncaa basketball") || t.contains("college basketball")
        }
        o => t.contains(o),
    }
}

/// NBA Gamma `series_id` 回退拉取；与 `polysniper` 一致，可在 `leagues.json` 覆盖
const NBA_DEFAULT_SERIES_ID: i64 = 10345;

pub struct BoardDeps {
    pub gamma: GammaClient,
    pub clob: ClobClient,
    pub teams: Vec<TeamMapping>,
}

impl BoardDeps {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            gamma: GammaClient::default(),
            clob: ClobClient::new("https://clob.polymarket.com", ClobConfig::default())?,
            teams: vec![],
        })
    }

    pub async fn quote_token(&self, token_id: &str) -> anyhow::Result<(f64, f64, f64, f64, f64)> {
        let tid = U256::from_str(token_id).context("token id")?;
        let mid_r = self
            .clob
            .midpoint(
                &polymarket_client_sdk_v2::clob::types::request::MidpointRequest::builder()
                    .token_id(tid)
                    .build(),
            )
            .await
            .ok();
        let mid = mid_r.map(|m| dec_to_f64(Some(m.mid))).unwrap_or(0.0);
        let book = self
            .clob
            .order_book(&OrderBookSummaryRequest::builder().token_id(tid).build())
            .await
            .ok();
        let mut best_bid = book
            .as_ref()
            .and_then(|b| b.bids.first())
            .map(|l| dec_to_f64(Some(l.price)))
            .unwrap_or(0.0);
        let mut best_ask = book
            .as_ref()
            .and_then(|b| b.asks.first())
            .map(|l| dec_to_f64(Some(l.price)))
            .unwrap_or(0.0);
        if best_bid > 0.0 && best_ask > 0.0 && best_ask > best_bid {
            // keep
        } else if mid > 0.0 {
            best_bid = clamp01(mid - 0.005);
            best_ask = clamp01(mid + 0.005);
            if best_ask <= best_bid {
                best_ask = clamp01(best_bid + 0.01);
            }
        }
        let bid_depth = book.as_ref().map(|b| sum_depth(&b.bids)).unwrap_or(0.0);
        let ask_depth = book.as_ref().map(|b| sum_depth(&b.asks)).unwrap_or(0.0);
        Ok((mid, best_bid, best_ask, bid_depth, ask_depth))
    }

    /// 批量 CLOB midpoint + order book（与逐 token `quote_token` 语义一致，显著减少 RTT）
    pub async fn batch_quote_tokens(
        &self,
        token_ids: &[String],
    ) -> HashMap<String, (f64, f64, f64, f64, f64)> {
        use polymarket_client_sdk_v2::clob::types::request::{
            MidpointRequest, OrderBookSummaryRequest,
        };
        let mut map: HashMap<String, (f64, f64, f64, f64, f64)> = HashMap::new();
        const CHUNK: usize = 60;
        for chunk in token_ids.chunks(CHUNK) {
            let mut mids_req: Vec<MidpointRequest> = vec![];
            let mut chunk_tok: Vec<String> = vec![];
            for s in chunk {
                let t = s.trim();
                if t.is_empty() {
                    continue;
                }
                if let Ok(tid) = U256::from_str(t) {
                    mids_req.push(MidpointRequest::builder().token_id(tid).build());
                    chunk_tok.push(t.to_string());
                }
            }
            if mids_req.is_empty() {
                continue;
            }
            if let Ok(resp) = self.clob.midpoints(&mids_req).await {
                for (tid_u, mid) in resp.midpoints {
                    let mid_f = dec_to_f64(Some(mid));
                    map.insert(tid_u.to_string(), (mid_f, 0.0, 0.0, 0.0, 0.0));
                }
            }
            let books_req: Vec<OrderBookSummaryRequest> = chunk_tok
                .iter()
                .filter_map(|t| {
                    U256::from_str(t)
                        .ok()
                        .map(|tid| OrderBookSummaryRequest::builder().token_id(tid).build())
                })
                .collect();
            if books_req.is_empty() {
                continue;
            }
            if let Ok(books) = self.clob.order_books(&books_req).await {
                for (i, book) in books.iter().enumerate() {
                    if let Some(tid) = chunk_tok.get(i) {
                        let mut best_bid = book
                            .bids
                            .first()
                            .map(|l| dec_to_f64(Some(l.price)))
                            .unwrap_or(0.0);
                        let mut best_ask = book
                            .asks
                            .first()
                            .map(|l| dec_to_f64(Some(l.price)))
                            .unwrap_or(0.0);
                        let mid = map.get(tid).map(|x| x.0).unwrap_or(0.0);
                        if best_bid > 0.0 && best_ask > 0.0 && best_ask > best_bid {
                            // keep
                        } else if mid > 0.0 {
                            best_bid = clamp01(mid - 0.005);
                            best_ask = clamp01(mid + 0.005);
                            if best_ask <= best_bid {
                                best_ask = clamp01(best_bid + 0.01);
                            }
                        }
                        let bid_depth = sum_depth(&book.bids);
                        let ask_depth = sum_depth(&book.asks);
                        let use_mid = if mid > 0.0 {
                            mid
                        } else if best_bid > 0.0 && best_ask > 0.0 {
                            (best_bid + best_ask) / 2.0
                        } else {
                            0.0
                        };
                        map.insert(
                            tid.clone(),
                            (use_mid, best_bid, best_ask, bid_depth, ask_depth),
                        );
                    }
                }
            }
        }
        map
    }

    fn home_rows_from_nba_jobs(
        &self,
        jobs: Vec<NbaResolvedJob>,
        cfg: &LeagueConfig,
        date: &str,
        status_filter: &str,
        quotes: &HashMap<String, (f64, f64, f64, f64, f64)>,
    ) -> Vec<HomeMarketItem> {
        let league_label = cfg.label.clone();
        let mut out: Vec<HomeMarketItem> = vec![];
        for job in jobs {
            let ev = job.event;
            let m = job.market;
            let tokens = gamma_tokens(&m);
            if tokens.len() != 2 {
                continue;
            }
            let start_iso = if !job.tip_off_rfc3339.trim().is_empty() {
                job.tip_off_rfc3339.clone()
            } else {
                game_tip_off_iso(&ev, &m)
            };
            let start_iso = if start_iso.trim().is_empty() {
                event_game_time_iso(&ev)
            } else {
                start_iso
            };
            if !date.is_empty() {
                let ny = events_feed::tip_off_date_ny(&start_iso);
                if ny.as_deref() != Some(date) {
                    continue;
                }
            }
            let st = derive_status(
                &start_iso,
                &ev.end_date.map(|d| d.to_rfc3339()).unwrap_or_default(),
            );
            if !passes_status_filter(&st, status_filter) {
                continue;
            }
            let zh = chinese_line(&ev.title.clone().unwrap_or_default(), &self.teams);
            let ev_slug = ev.slug.clone().unwrap_or_default();
            let ev_id = ev.id.clone();
            let q_base = ev.title.clone().unwrap_or_default();
            let market_id = m.id.clone();
            let cond = m
                .condition_id
                .map(|c| format!("{:#x}", c))
                .unwrap_or_default();
            let v24 = dec_to_f64(m.volume_24hr.or(m.volume));
            let status = derive_status(
                &start_iso,
                &ev.end_date.map(|d| d.to_rfc3339()).unwrap_or_default(),
            );

            for (ti, (tok, outcome, gamma_price)) in tokens.iter().enumerate() {
                let tid = tok.clone();
                let other = tokens
                    .iter()
                    .enumerate()
                    .find(|(j, _)| *j != ti)
                    .map(|(_, (t, _, _))| t.clone())
                    .unwrap_or_default();
                let qtext = if outcome.trim().is_empty() {
                    q_base.clone()
                } else {
                    format!("{} · {}", q_base, outcome)
                };
                let (mut mid, best_bid, best_ask, bid_depth, ask_depth) = quotes
                    .get(&tid)
                    .copied()
                    .unwrap_or((0.0, 0.0, 0.0, 0.0, 0.0));
                if mid <= 0.0 && *gamma_price > 0.0 {
                    mid = *gamma_price;
                }
                let spread = (best_ask - best_bid).max(0.0);
                let row_id = format!("{}:{}", ev_id, tid);
                let poly_url = if !ev_slug.is_empty() {
                    Some(format!("https://polymarket.com/event/{ev_slug}"))
                } else {
                    None
                };
                out.push(HomeMarketItem {
                    id: row_id,
                    event_id: Some(ev_id.clone()),
                    event_slug: if ev_slug.is_empty() {
                        None
                    } else {
                        Some(ev_slug.clone())
                    },
                    question: qtext,
                    league: league_label.clone(),
                    start_time: start_iso.clone(),
                    yes_token_id: Some(tid.clone()),
                    no_token_id: if other.is_empty() { None } else { Some(other) },
                    open_price: mid,
                    best_bid,
                    best_ask,
                    mid_price: mid,
                    spread,
                    bid_depth,
                    ask_depth,
                    volume24h: Some(v24),
                    polymarket_url: poly_url,
                    chinese_subtitle: if zh.is_empty() {
                        None
                    } else {
                        Some(zh.clone())
                    },
                    tier: derive_tier(mid),
                    suggested_amount: Some(0.0),
                    market_id: Some(market_id.clone()),
                    condition_id: if cond.is_empty() {
                        None
                    } else {
                        Some(cond.clone())
                    },
                    status: Some(status.clone()),
                });
            }
        }
        out
    }

    /// Gamma tag / 全量列表 → 单场 moneyline（与旧逻辑一致）
    async fn gamma_moneyline_jobs(
        &self,
        cfg: &LeagueConfig,
        league_up: &str,
        date: &str,
        status_filter: &str,
        tz_offset: i32,
    ) -> anyhow::Result<
        Vec<(
            polymarket_client_sdk_v2::gamma::types::response::Event,
            polymarket_client_sdk_v2::gamma::types::response::Market,
        )>,
    > {
        let events = if cfg.tag_id > 0 {
            self.gamma
                .events(
                    &EventsRequest::builder()
                        .tag_id(cfg.tag_id.to_string())
                        .limit(50)
                        .active(true)
                        .closed(false)
                        .ascending(true)
                        .build(),
                )
                .await
                .context("gamma events")?
        } else {
            self.gamma
                .events(
                    &EventsRequest::builder()
                        .limit(50)
                        .active(true)
                        .closed(false)
                        .ascending(true)
                        .build(),
                )
                .await
                .context("gamma events all")?
        };

        let mut jobs: Vec<(
            polymarket_client_sdk_v2::gamma::types::response::Event,
            polymarket_client_sdk_v2::gamma::types::response::Market,
        )> = vec![];
        for ev in events {
            let title = ev.title.clone().unwrap_or_default();
            let ev_slug = ev.slug.clone().unwrap_or_default();
            let active = ev.active.unwrap_or(false);
            let closed = ev.closed.unwrap_or(false);
            if !is_real_matchup(active, closed, &title) {
                continue;
            }
            if is_series_or_non_single_game_event(&title, &ev_slug) {
                continue;
            }
            if cfg.tag_id == 0 && !title_matches_league(&title, league_up) {
                continue;
            }
            let markets_owned = ev.markets.clone().unwrap_or_default();
            let Some(ml) = pick_moneyline(&markets_owned) else {
                continue;
            };
            let tip = game_tip_off_iso(&ev, ml);
            if !date.is_empty() {
                if iso_to_local_ymd(&tip, tz_offset).as_deref() != Some(date) {
                    continue;
                }
            }
            let st = derive_status(
                &tip,
                &ev.end_date.map(|d| d.to_rfc3339()).unwrap_or_default(),
            );
            if !passes_status_filter(&st, status_filter) {
                continue;
            }
            jobs.push((ev, ml.clone()));
        }
        Ok(jobs)
    }

    pub async fn fetch_home_markets(
        &self,
        leagues_cfg: &[LeagueConfig],
        league: &str,
        date: &str,
        status_filter: &str,
        tz_offset: i32,
    ) -> anyhow::Result<Vec<HomeMarketItem>> {
        let league_up = league.to_uppercase();
        let lg = league.to_lowercase();
        let Some(cfg) = leagues::league_by_slug(leagues_cfg, &lg) else {
            return Ok(vec![]);
        };

        if lg == "nba" {
            let series_for_gamma = if cfg.series_id > 0 {
                cfg.series_id
            } else {
                NBA_DEFAULT_SERIES_ID
            };
            let slug_prefix = cfg.slug.to_lowercase();
            let mut jobs =
                events_feed::resolve_nba_event_jobs(&self.gamma, series_for_gamma, &slug_prefix)
                    .await
                    .unwrap_or_default();
            if jobs.is_empty() && cfg.tag_id > 0 {
                let pairs = self
                    .gamma_moneyline_jobs(cfg, &league_up, date, status_filter, tz_offset)
                    .await
                    .unwrap_or_default();
                jobs = pairs
                    .into_iter()
                    .map(|(ev, m)| {
                        let tip = game_tip_off_iso(&ev, &m);
                        NbaResolvedJob {
                            event: ev,
                            market: m,
                            tip_off_rfc3339: tip,
                        }
                    })
                    .collect();
            }
            let mut token_ids: Vec<String> = vec![];
            for j in &jobs {
                for (tid, _, _) in gamma_tokens(&j.market) {
                    if !tid.is_empty() {
                        token_ids.push(tid);
                    }
                }
            }
            let quotes = self.batch_quote_tokens(&token_ids).await;
            let mut out = self.home_rows_from_nba_jobs(jobs, cfg, date, status_filter, &quotes);
            out.sort_by(|a, b| {
                let ta = parse_flexible_time(&a.start_time);
                let tb = parse_flexible_time(&b.start_time);
                match (ta, tb) {
                    (Some(x), Some(y)) if x != y => x.cmp(&y),
                    _ => a.question.cmp(&b.question),
                }
            });
            return Ok(out);
        }

        let jobs = self
            .gamma_moneyline_jobs(cfg, &league_up, date, status_filter, tz_offset)
            .await?;

        let mut token_ids: Vec<String> = vec![];
        for (_, m) in &jobs {
            for (tid, _, _) in gamma_tokens(m) {
                if !tid.is_empty() {
                    token_ids.push(tid);
                }
            }
        }
        let quotes = self.batch_quote_tokens(&token_ids).await;
        let mut out: Vec<HomeMarketItem> = vec![];
        for (ev, m) in jobs {
            let tokens = gamma_tokens(&m);
            if tokens.len() != 2 {
                continue;
            }
            let start_iso = game_tip_off_iso(&ev, &m);
            let start_iso = if start_iso.is_empty() {
                event_game_time_iso(&ev)
            } else {
                start_iso
            };
            let zh = chinese_line(&ev.title.clone().unwrap_or_default(), &self.teams);
            let status = derive_status(
                &start_iso,
                &ev.end_date.map(|d| d.to_rfc3339()).unwrap_or_default(),
            );
            let ev_slug = ev.slug.clone().unwrap_or_default();
            let ev_id = ev.id.clone();
            let q_base = ev.title.clone().unwrap_or_default();
            let market_id = m.id.clone();
            let cond = m
                .condition_id
                .map(|c| format!("{:#x}", c))
                .unwrap_or_default();
            let v24 = dec_to_f64(m.volume_24hr.or(m.volume));
            let league_label = cfg.label.clone();

            for (ti, (tok, outcome, gamma_price)) in tokens.iter().enumerate() {
                let tid = tok.clone();
                let other = tokens
                    .iter()
                    .enumerate()
                    .find(|(j, _)| *j != ti)
                    .map(|(_, (t, _, _))| t.clone())
                    .unwrap_or_default();
                let qtext = if outcome.trim().is_empty() {
                    q_base.clone()
                } else {
                    format!("{} · {}", q_base, outcome)
                };
                let (mut mid, best_bid, best_ask, bid_depth, ask_depth) = quotes
                    .get(&tid)
                    .copied()
                    .unwrap_or((0.0, 0.0, 0.0, 0.0, 0.0));
                if mid <= 0.0 && *gamma_price > 0.0 {
                    mid = *gamma_price;
                }
                let spread = (best_ask - best_bid).max(0.0);
                let row_id = format!("{}:{}", ev_id, tid);
                let poly_url = if !ev_slug.is_empty() {
                    Some(format!("https://polymarket.com/event/{ev_slug}"))
                } else {
                    None
                };
                out.push(HomeMarketItem {
                    id: row_id,
                    event_id: Some(ev_id.clone()),
                    event_slug: if ev_slug.is_empty() {
                        None
                    } else {
                        Some(ev_slug.clone())
                    },
                    question: qtext,
                    league: league_label.clone(),
                    start_time: start_iso.clone(),
                    yes_token_id: Some(tid.clone()),
                    no_token_id: if other.is_empty() { None } else { Some(other) },
                    open_price: mid,
                    best_bid,
                    best_ask,
                    mid_price: mid,
                    spread,
                    bid_depth,
                    ask_depth,
                    volume24h: Some(v24),
                    polymarket_url: poly_url,
                    chinese_subtitle: if zh.is_empty() {
                        None
                    } else {
                        Some(zh.clone())
                    },
                    tier: derive_tier(mid),
                    suggested_amount: Some(0.0),
                    market_id: Some(market_id.clone()),
                    condition_id: if cond.is_empty() {
                        None
                    } else {
                        Some(cond.clone())
                    },
                    status: Some(status.clone()),
                });
            }
        }
        out.sort_by(|a, b| {
            let ta = parse_flexible_time(&a.start_time);
            let tb = parse_flexible_time(&b.start_time);
            match (ta, tb) {
                (Some(x), Some(y)) if x != y => x.cmp(&y),
                _ => a.question.cmp(&b.question),
            }
        });
        Ok(out)
    }
}

fn sum_depth(levels: &[polymarket_client_sdk_v2::clob::types::response::OrderSummary]) -> f64 {
    let max = levels.len().min(5);
    let mut t = 0.0;
    for i in 0..max {
        let sz = dec_to_f64(Some(levels[i].size));
        let pr = dec_to_f64(Some(levels[i].price));
        t += sz * pr;
    }
    t
}

pub async fn resolve_tokens_meta(
    gamma: &GammaClient,
    token_ids: &[String],
) -> anyhow::Result<HashMap<String, serde_json::Value>> {
    let mut out = HashMap::new();
    for chunk in token_ids.chunks(25) {
        let u256s: Vec<U256> = chunk
            .iter()
            .filter_map(|s| U256::from_str(s.trim()).ok())
            .collect();
        if u256s.is_empty() {
            continue;
        }
        let mut gms = gamma
            .markets(
                &MarketsRequest::builder()
                    .clob_token_ids(u256s.clone())
                    .limit(100)
                    .build(),
            )
            .await?;
        let mut unresolved: Vec<U256> = Vec::new();
        for tid in &u256s {
            if !gms.iter().any(|m| {
                m.clob_token_ids
                    .as_ref()
                    .map(|ids| ids.iter().any(|x| x == tid))
                    .unwrap_or(false)
            }) {
                unresolved.push(*tid);
            }
        }
        // Some short-cycle crypto markets are absent from default feed unless querying closed=true.
        if !unresolved.is_empty() {
            let mut extra = gamma
                .markets(
                    &MarketsRequest::builder()
                        .clob_token_ids(unresolved)
                        .closed(true)
                        .limit(100)
                        .build(),
                )
                .await?;
            gms.append(&mut extra);
        }
        for gm in gms {
            let q = gm.question.clone().unwrap_or_default();
            let (ev_slug, ev_title) = gm
                .events
                .as_ref()
                .and_then(|es| es.first())
                .map(|e| {
                    (
                        e.slug.clone().unwrap_or_default(),
                        e.title.clone().unwrap_or_default(),
                    )
                })
                .unwrap_or_default();
            let slug_for_url = if !ev_slug.is_empty() {
                ev_slug.clone()
            } else {
                gm.slug.clone().unwrap_or_default()
            };
            let polymarket_url = if !slug_for_url.is_empty() {
                Some(format!("https://polymarket.com/event/{slug_for_url}"))
            } else {
                None
            };
            for (tid, oc, _) in gamma_tokens(&gm) {
                if tid.is_empty() {
                    continue;
                }
                out.insert(
                    tid,
                    serde_json::json!({
                        "question": q,
                        "outcome": oc,
                        "eventSlug": if ev_slug.is_empty() {
                            serde_json::Value::Null
                        } else {
                            ev_slug.clone().into()
                        },
                        "polymarketUrl": polymarket_url,
                        "eventTitle": if ev_title.is_empty() {
                            serde_json::Value::String(q.clone())
                        } else {
                            serde_json::Value::String(ev_title.clone())
                        },
                    }),
                );
            }
        }
    }
    Ok(out)
}
