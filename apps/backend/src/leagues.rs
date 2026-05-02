use std::path::Path;

use anyhow::Context;

use crate::models::{LeagueConfig, LeaguesFile};

const DEFAULT_LEAGUES_JSON: &str = r#"{"leagues":[
  {"slug":"nba","name":"NBA","label":"NBA","seriesId":10345,"tagId":745,"icon":"🏀"},
  {"slug":"ncaab","name":"NCAAB","label":"NCAAB","seriesId":0,"tagId":101952,"icon":"🏀"},
  {"slug":"nhl","name":"NHL","label":"NHL","seriesId":10346,"tagId":899,"icon":"🏒"}
]}"#;

pub async fn load_leagues(path: impl AsRef<Path>) -> anyhow::Result<Vec<LeagueConfig>> {
    let path = path.as_ref();
    if tokio::fs::try_exists(path).await.unwrap_or(false) {
        let raw = tokio::fs::read_to_string(path).await?;
        let f: LeaguesFile = serde_json::from_str(&raw).context("parse leagues")?;
        return Ok(f.leagues);
    }
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.ok();
    }
    let f: LeaguesFile = serde_json::from_str(DEFAULT_LEAGUES_JSON)?;
    let raw = serde_json::to_string_pretty(&f)?;
    tokio::fs::write(path, raw).await.ok();
    Ok(f.leagues)
}

pub fn league_by_slug<'a>(leagues: &'a [LeagueConfig], slug: &str) -> Option<&'a LeagueConfig> {
    let s = slug.to_lowercase();
    leagues.iter().find(|l| l.slug.to_lowercase() == s)
}
