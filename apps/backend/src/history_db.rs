use anyhow::Context;
use sqlx::sqlite::SqlitePoolOptions;

use crate::models::ClosedHistoryRow;

pub struct HistoryDb {
    pool: sqlx::SqlitePool,
}

impl HistoryDb {
    pub async fn connect(path: &std::path::Path) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent() {
            tokio::fs::create_dir_all(dir).await.ok();
        }
        let url = format!("sqlite:{}?mode=rwc", path.display());
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .context("sqlite connect")?;
        sqlx::query(
            r#"CREATE TABLE IF NOT EXISTS closed_positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                position_id TEXT NOT NULL,
                market_id TEXT,
                event_id TEXT,
                condition_id TEXT,
                token_id TEXT NOT NULL,
                outcome_label TEXT,
                shares REAL NOT NULL,
                cost_usdc REAL NOT NULL,
                avg_entry_price REAL NOT NULL,
                high_water_mark REAL NOT NULL,
                stop_trail_pct REAL NOT NULL,
                close_reason TEXT NOT NULL,
                order_id TEXT,
                paper INTEGER NOT NULL DEFAULT 0,
                last_bid REAL,
                last_mid REAL,
                closed_at TEXT NOT NULL
            )"#,
        )
        .execute(&pool)
        .await?;
        Ok(Self { pool })
    }

    pub async fn record_closed(
        &self,
        position_id: &str,
        market_id: Option<&str>,
        event_id: Option<&str>,
        condition_id: Option<&str>,
        token_id: &str,
        outcome_label: Option<&str>,
        shares: f64,
        cost_usdc: f64,
        avg_entry_price: f64,
        high_water_mark: f64,
        stop_trail_pct: f64,
        close_reason: &str,
        order_id: Option<&str>,
        paper: bool,
        last_bid: f64,
        last_mid: f64,
        closed_at: &str,
    ) -> anyhow::Result<()> {
        sqlx::query(
            r#"INSERT INTO closed_positions (
                position_id, market_id, event_id, condition_id, token_id, outcome_label,
                shares, cost_usdc, avg_entry_price, high_water_mark, stop_trail_pct,
                close_reason, order_id, paper, last_bid, last_mid, closed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(position_id)
        .bind(market_id)
        .bind(event_id)
        .bind(condition_id)
        .bind(token_id)
        .bind(outcome_label)
        .bind(shares)
        .bind(cost_usdc)
        .bind(avg_entry_price)
        .bind(high_water_mark)
        .bind(stop_trail_pct)
        .bind(close_reason)
        .bind(order_id)
        .bind(if paper { 1i32 } else { 0 })
        .bind(last_bid)
        .bind(last_mid)
        .bind(closed_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_recent(&self, limit: i64) -> anyhow::Result<Vec<ClosedHistoryRow>> {
        let rows = sqlx::query_as::<_, ClosedRowSql>(
            "SELECT position_id, market_id, event_id, condition_id, token_id, outcome_label,
                    shares, cost_usdc, avg_entry_price, high_water_mark, stop_trail_pct,
                    close_reason, order_id, paper, last_bid, last_mid, closed_at
             FROM closed_positions ORDER BY id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|r| r.into()).collect())
    }
}

#[derive(sqlx::FromRow)]
struct ClosedRowSql {
    position_id: String,
    market_id: Option<String>,
    event_id: Option<String>,
    condition_id: Option<String>,
    token_id: String,
    outcome_label: Option<String>,
    shares: f64,
    cost_usdc: f64,
    avg_entry_price: f64,
    high_water_mark: f64,
    stop_trail_pct: f64,
    close_reason: String,
    order_id: Option<String>,
    paper: i32,
    last_bid: Option<f64>,
    last_mid: Option<f64>,
    closed_at: String,
}

impl From<ClosedRowSql> for ClosedHistoryRow {
    fn from(r: ClosedRowSql) -> Self {
        ClosedHistoryRow {
            position_id: r.position_id,
            market_id: r.market_id,
            event_id: r.event_id,
            condition_id: r.condition_id,
            token_id: r.token_id,
            outcome_label: r.outcome_label,
            shares: r.shares,
            cost_usdc: r.cost_usdc,
            avg_entry_price: r.avg_entry_price,
            high_water_mark: r.high_water_mark,
            stop_trail_pct: r.stop_trail_pct,
            close_reason: r.close_reason,
            order_id: r.order_id,
            paper: r.paper != 0,
            last_bid: r.last_bid,
            last_mid: r.last_mid,
            closed_at: r.closed_at,
        }
    }
}
