use std::collections::HashMap;
use std::sync::OnceLock;

use anyhow::Context;
use chrono::{DateTime, Days, Utc};
use chrono_tz::America::New_York;
use chrono_tz::Asia::Shanghai;
use polymarket_client_sdk_v2::gamma::Client as GammaClient;
use polymarket_client_sdk_v2::gamma::types::request::EventBySlugRequest;
use polymarket_client_sdk_v2::gamma::types::response::{Event, Market};
use serde::Deserialize;

const GAMMA_HOST: &str = "https://gamma-api.polymarket.com";
const ESPN_SCOREBOARD: &str =
    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard";

#[derive(Debug, Clone, Deserialize)]
struct NbaTeamRow {
    abbr: String,
    #[serde(rename = "espnName")]
    espn_name: String,
}

fn nba_teams_table() -> &'static [NbaTeamRow] {
    static T: OnceLock<Vec<NbaTeamRow>> = OnceLock::new();
    T.get_or_init(|| {
        serde_json::from_str(include_str!("../../data/nba_espn_teams.json"))
            .expect("nba_espn_teams.json")
    })
}

fn find_team_by_espn_display(name: &str) -> Option<&'static NbaTeamRow> {
    let n = name.trim().to_lowercase();
    let rows = nba_teams_table();
    for t in rows {
        if t.espn_name.to_lowercase() == n {
            return Some(t);
        }
    }
    for t in rows {
        let en = t.espn_name.to_lowercase();
        if let Some(last) = en.rsplit(' ').next() {
            if n.contains(last) || last.contains(&n) {
                return Some(t);
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct NbaResolvedJob {
    pub event: Event,
    pub market: Market,
    /// 优先 ESPN 开赛时间 RFC3339；用于展示与赛历过滤
    pub tip_off_rfc3339: String,
}

#[derive(Debug, Deserialize)]
struct EspnScoreboard {
    #[serde(default)]
    events: Vec<EspnEvent>,
}

#[derive(Debug, Deserialize)]
struct EspnEvent {
    id: String,
    date: String,
    #[serde(default)]
    competitions: Vec<EspnCompetition>,
}

#[derive(Debug, Deserialize)]
struct EspnCompetition {
    #[serde(default)]
    competitors: Vec<EspnCompetitor>,
}

#[derive(Debug, Deserialize)]
struct EspnCompetitor {
    #[serde(rename = "homeAway")]
    home_away: String,
    team: EspnTeam,
}

#[derive(Debug, Deserialize)]
struct EspnTeam {
    #[serde(rename = "displayName")]
    display_name: String,
}

fn shanghai_scoreboard_dates() -> Vec<String> {
    let today = Utc::now().with_timezone(&Shanghai).date_naive();
    let start = today.checked_sub_days(Days::new(1)).unwrap_or(today);
    let mut out = Vec::new();
    for i in 0..4 {
        let d = start.checked_add_days(Days::new(i)).unwrap_or(start);
        out.push(d.format("%Y%m%d").to_string());
    }
    out
}

async fn fetch_espn_games(
    http: &reqwest::Client,
) -> anyhow::Result<Vec<(String, String, String, String)>> {
    let mut all = Vec::new();
    let dates = shanghai_scoreboard_dates();
    for d in dates {
        let url = format!("{ESPN_SCOREBOARD}?dates={d}");
        let sb: EspnScoreboard = http
            .get(&url)
            .timeout(std::time::Duration::from_secs(12))
            .send()
            .await
            .with_context(|| format!("espn get {url}"))?
            .error_for_status()
            .with_context(|| format!("espn status {url}"))?
            .json()
            .await
            .with_context(|| format!("espn json {url}"))?;
        for ev in sb.events {
            let Some(comp) = ev.competitions.first() else {
                continue;
            };
            let mut home_name = String::new();
            let mut away_name = String::new();
            for c in &comp.competitors {
                if c.home_away.eq_ignore_ascii_case("home") {
                    home_name = c.team.display_name.clone();
                } else if c.home_away.eq_ignore_ascii_case("away") {
                    away_name = c.team.display_name.clone();
                }
            }
            if home_name.is_empty() || away_name.is_empty() {
                continue;
            }
            all.push((ev.id.clone(), ev.date.clone(), home_name, away_name));
        }
    }
    // 去重（多天窗口可能重复 event id）
    let mut seen = HashMap::new();
    for row in all {
        seen.insert(row.0.clone(), row);
    }
    Ok(seen.into_values().collect())
}

fn utc_slug_dates() -> (String, String) {
    let today = Utc::now().date_naive();
    let yest = today.checked_sub_days(Days::new(1)).unwrap_or(today);
    (
        today.format("%Y-%m-%d").to_string(),
        yest.format("%Y-%m-%d").to_string(),
    )
}

fn is_series_or_non_single_game_event(title: &str, event_slug: &str) -> bool {
    let t = title.to_lowercase();
    let s = event_slug.to_lowercase();
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
    if t.contains("playoffs") && t.contains("series") && t.contains("who will") {
        return true;
    }
    if s.contains("series-winner")
        || s.contains("who-wins-series")
        || s.contains("win-series")
        || s.ends_with("-series")
    {
        return true;
    }
    false
}

/// 与 polysniper `winnerMarket` 排除词表对齐
fn pick_winner_moneyline<'a>(markets: &'a [Market]) -> Option<&'a Market> {
    let mut fallback = None;
    for m in markets {
        let active = m.active.unwrap_or(false);
        let closed = m.closed.unwrap_or(false);
        if !active || closed {
            continue;
        }
        if m.market_type
            .as_deref()
            .is_some_and(|t| t.eq_ignore_ascii_case("moneyline"))
        {
            return Some(m);
        }
        let question = format!(
            "{} {}",
            m.question.as_deref().unwrap_or(""),
            m.slug.as_deref().unwrap_or("")
        )
        .to_lowercase();
        let exclude = [
            "spread",
            "handicap",
            "points",
            "total",
            "over",
            "o/u",
            "quarter",
            "1q",
            "2q",
            "3q",
            "4q",
            "q1",
            "q2",
            "q3",
            "q4",
            "half",
            "1h",
            "2h",
            "first half",
            "second half",
            "more than",
            "less than",
            "by more",
            "beat by",
        ];
        let has_under = question.contains("under") && !question.contains("thunder");
        if exclude.iter().any(|k| question.contains(k)) || has_under {
            continue;
        }
        let include = ["winner", "win", "vs", "vs."];
        if include.iter().any(|k| question.contains(k)) || question.contains("vs") {
            fallback = Some(m);
        }
    }
    fallback
}

fn event_team_match(text: &str, t: &NbaTeamRow) -> bool {
    let x = text.to_lowercase();
    let abbr = t.abbr.to_lowercase();
    if x.contains(&abbr) {
        return true;
    }
    for w in t.espn_name.split_whitespace() {
        let w = w.to_lowercase();
        if w.len() >= 3 && x.contains(&w) {
            return true;
        }
    }
    false
}

async fn fetch_series_events(http: &reqwest::Client, series_id: i64) -> anyhow::Result<Vec<Event>> {
    let url =
        format!("{GAMMA_HOST}/events?series_id={series_id}&limit=120&active=true&closed=false");
    let v: Vec<Event> = http
        .get(&url)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .context("gamma series events")?
        .error_for_status()
        .context("gamma series status")?
        .json()
        .await
        .context("gamma series json")?;
    Ok(v)
}

async fn resolve_one_game(
    gamma: &GammaClient,
    series_cache: &Option<Vec<Event>>,
    slug_prefix: &str,
    espn_date: &str,
    home_name: &str,
    away_name: &str,
) -> anyhow::Result<Option<NbaResolvedJob>> {
    let home = match find_team_by_espn_display(home_name) {
        Some(t) => t,
        None => return Ok(None),
    };
    let away = match find_team_by_espn_display(away_name) {
        Some(t) => t,
        None => return Ok(None),
    };
    let (d0, d1) = utc_slug_dates();
    let ha = home.abbr.to_lowercase();
    let aa = away.abbr.to_lowercase();
    let slugs = [
        format!("{slug_prefix}-{ha}-{aa}-{d0}"),
        format!("{slug_prefix}-{aa}-{ha}-{d0}"),
        format!("{slug_prefix}-{ha}-{aa}-{d1}"),
        format!("{slug_prefix}-{aa}-{ha}-{d1}"),
    ];
    for s in &slugs {
        if let Ok(ev) = gamma
            .event_by_slug(&EventBySlugRequest::builder().slug(s.clone()).build())
            .await
        {
            let title = ev.title.clone().unwrap_or_default();
            let slug = ev.slug.clone().unwrap_or_default();
            if is_series_or_non_single_game_event(&title, &slug) {
                continue;
            }
            let markets = ev.markets.clone().unwrap_or_default();
            if let Some(ml) = pick_winner_moneyline(&markets) {
                let tip = polymarket_game_start_rfc3339(&ev, ml);
                let tip = if tip.trim().is_empty() {
                    parse_espn_date_to_rfc3339(espn_date)
                } else {
                    tip
                };
                return Ok(Some(NbaResolvedJob {
                    event: ev,
                    market: ml.clone(),
                    tip_off_rfc3339: tip,
                }));
            }
        }
    }
    let Some(cache) = series_cache else {
        return Ok(None);
    };
    for ev in cache {
        let title = ev.title.clone().unwrap_or_default();
        let slug = ev.slug.clone().unwrap_or_default();
        if ev.closed.unwrap_or(false) || !ev.active.unwrap_or(true) {
            continue;
        }
        if is_series_or_non_single_game_event(&title, &slug) {
            continue;
        }
        let blob = format!("{title} {slug}").to_lowercase();
        if !blob.contains("nba") && !blob.contains("basketball") {
            continue;
        }
        if !event_team_match(&blob, home) || !event_team_match(&blob, away) {
            continue;
        }
        let markets = ev.markets.clone().unwrap_or_default();
        if let Some(ml) = pick_winner_moneyline(&markets) {
            let tip = polymarket_game_start_rfc3339(ev, ml);
            let tip = if tip.trim().is_empty() {
                parse_espn_date_to_rfc3339(espn_date)
            } else {
                tip
            };
            return Ok(Some(NbaResolvedJob {
                event: ev.clone(),
                market: ml.clone(),
                tip_off_rfc3339: tip,
            }));
        }
    }
    Ok(None)
}

/// 与 Polymarket 前端/规则页一致：优先 Gamma 赛事与盘口上的开赛时间，而不是 ESPN `date`。
pub fn polymarket_game_start_rfc3339(ev: &Event, m: &Market) -> String {
    if let Some(st) = ev.start_time {
        return st.to_rfc3339();
    }
    if let Some(ref gs) = m.game_start_time {
        let t = gs.trim();
        if let Ok(dt) = DateTime::parse_from_rfc3339(t) {
            return dt.with_timezone(&Utc).to_rfc3339();
        }
        if let Ok(dt) = t.parse::<DateTime<Utc>>() {
            return dt.to_rfc3339();
        }
    }
    if let Some(et) = m.event_start_time {
        return et.to_rfc3339();
    }
    if let Some(sd) = m.start_date {
        return sd.to_rfc3339();
    }
    if let Some(sd) = ev.start_date {
        return sd.to_rfc3339();
    }
    String::new()
}

fn parse_espn_date_to_rfc3339(espn_date: &str) -> String {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(espn_date.trim()) {
        return dt.with_timezone(&Utc).to_rfc3339();
    }
    if let Ok(dt) = espn_date.trim().parse::<chrono::DateTime<Utc>>() {
        return dt.to_rfc3339();
    }
    espn_date.to_string()
}

/// 美东日历日 `YYYY-MM-DD`，用于与查询参数 `date=` 对齐。
pub fn tip_off_date_ny(tip_rfc3339: &str) -> Option<String> {
    let t = chrono::DateTime::parse_from_rfc3339(tip_rfc3339.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .or_else(|| tip_rfc3339.trim().parse::<chrono::DateTime<Utc>>().ok())?;
    let ny = t.with_timezone(&New_York);
    Some(ny.date_naive().format("%Y-%m-%d").to_string())
}

/// 返回去重后的 NBA 单场（ESPN × Polymarket 对齐）。`series_id<=0` 时不会拉 series 回退。
pub async fn resolve_nba_event_jobs(
    gamma: &GammaClient,
    series_id: i64,
    slug_prefix: &str,
) -> anyhow::Result<Vec<NbaResolvedJob>> {
    let http = reqwest::Client::builder()
        .user_agent("polybackend/1.0 (events_feed)")
        .build()
        .context("reqwest client")?;
    let games = fetch_espn_games(&http).await.unwrap_or_default();
    let series_cache = if series_id > 0 {
        Some(
            fetch_series_events(&http, series_id)
                .await
                .unwrap_or_default(),
        )
    } else {
        None
    };
    let mut out: Vec<NbaResolvedJob> = Vec::new();
    let mut seen_slug: HashMap<String, ()> = HashMap::new();
    for (_eid, date, home, away) in games {
        let job = resolve_one_game(gamma, &series_cache, slug_prefix, &date, &home, &away).await?;
        let Some(j) = job else { continue };
        let slug = j.event.slug.clone().unwrap_or_default();
        if slug.is_empty() {
            out.push(j);
            continue;
        }
        if seen_slug.insert(slug, ()).is_none() {
            out.push(j);
        }
    }
    out.sort_by(|a, b| a.tip_off_rfc3339.cmp(&b.tip_off_rfc3339));
    Ok(out)
}
