//! ESPN 赛程 + Polymarket Gamma slug / series 漏斗（对齐 `polysniper` 的 `searchNBAMarkets` + `dataAggregator`）。
//! 仅负责「是哪几场球、对应哪个 Gamma event / 胜负盘 market」；CLOB 价格在 `board` 批量拉取。

mod nba;

pub use nba::{
    NbaResolvedJob, polymarket_game_start_rfc3339, resolve_nba_event_jobs, tip_off_date_ny,
};
