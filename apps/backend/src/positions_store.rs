use std::collections::HashMap;
use std::path::PathBuf;

use anyhow::Context;
use chrono::Utc;
use parking_lot::RwLock;
use uuid::Uuid;

use crate::models::{CloseTask, Position, PositionsStateFile, RiskConfig};

const STATE_SCHEMA: &str = "positions-state-v1";

pub struct PositionStore {
    path: PathBuf,
    inner: RwLock<Inner>,
}

struct Inner {
    risk: RiskConfig,
    by_id: HashMap<String, Position>,
    risk_keys: HashMap<String, ()>,
    close_tasks: HashMap<String, CloseTask>,
}

impl PositionStore {
    pub async fn load_or_create(path: PathBuf) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        let inner = if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            let raw = tokio::fs::read_to_string(&path).await?;
            let f: PositionsStateFile = if raw.trim().is_empty() {
                PositionsStateFile::default()
            } else {
                serde_json::from_str(&raw).unwrap_or_default()
            };
            Inner::from_file(f)
        } else {
            Inner::default()
        };
        Ok(Self {
            path,
            inner: RwLock::new(inner),
        })
    }

    pub fn persist_blocking(&self) -> anyhow::Result<()> {
        let snap = self.inner.read().to_payload();
        let json = serde_json::to_string_pretty(&snap).context("serialize positions")?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).ok();
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, &json)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    fn persist_spawn(&self) {
        let path = self.path.clone();
        let snap = self.inner.read().to_payload();
        tokio::spawn(async move {
            let json = match serde_json::to_string_pretty(&snap) {
                Ok(j) => j,
                Err(_) => return,
            };
            if let Some(dir) = path.parent() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
            let tmp = path.with_extension("json.tmp");
            if tokio::fs::write(&tmp, &json).await.is_ok() {
                let _ = tokio::fs::rename(&tmp, &path).await;
            }
        });
    }

    pub fn risk_config(&self) -> RiskConfig {
        self.inner.read().risk.clone()
    }

    pub fn set_risk_config(&self, patch: RiskPatch) -> RiskConfig {
        let mut g = self.inner.write();
        if let Some(v) = patch.default_stop_trail_pct {
            g.risk.default_stop_trail_pct = v;
        }
        if let Some(v) = patch.min_tick_debounce_ms {
            g.risk.min_tick_debounce_ms = v;
        }
        let out = g.risk.clone();
        drop(g);
        self.persist_spawn();
        out
    }

    pub fn list_all(&self) -> Vec<Position> {
        self.inner.read().by_id.values().cloned().collect()
    }

    pub fn list_open(&self) -> Vec<Position> {
        self.inner
            .read()
            .by_id
            .values()
            .filter(|p| p.state == "open")
            .cloned()
            .collect()
    }

    pub fn list_for_price_feed(&self) -> Vec<Position> {
        self.inner
            .read()
            .by_id
            .values()
            .filter(|p| {
                (p.state == "open" || p.state == "stopped_out") && !p.token_id.trim().is_empty()
            })
            .cloned()
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<Position> {
        self.inner.read().by_id.get(id).cloned()
    }

    pub fn upsert(&self, mut p: Position) -> Position {
        let now = Utc::now().to_rfc3339();
        if p.id.trim().is_empty() {
            p.id = Uuid::new_v4().simple().to_string();
        }
        if p.created_at.is_empty() {
            p.created_at.clone_from(&now);
        }
        p.updated_at = now;
        self.inner.write().by_id.insert(p.id.clone(), p.clone());
        self.persist_spawn();
        p
    }

    pub fn update<F>(&self, id: &str, f: F) -> Option<Position>
    where
        F: FnOnce(&mut Position),
    {
        let mut g = self.inner.write();
        let p = g.by_id.get_mut(id)?;
        f(p);
        p.updated_at = Utc::now().to_rfc3339();
        let out = p.clone();
        drop(g);
        self.persist_spawn();
        Some(out)
    }

    pub fn try_claim_risk_key(&self, key: &str) -> bool {
        let mut g = self.inner.write();
        if g.risk_keys.contains_key(key) {
            return false;
        }
        g.risk_keys.insert(key.to_string(), ());
        self.persist_spawn();
        true
    }

    pub fn release_risk_key(&self, key: &str) {
        self.inner.write().risk_keys.remove(key);
        self.persist_spawn();
    }

    pub fn has_pending_close_task(&self, position_id: &str, kind: &str) -> bool {
        let key = close_task_key(position_id, kind);
        self.inner.read().close_tasks.contains_key(&key)
    }

    pub fn record_close_failure(&self, position_id: &str, kind: &str, err: &str) {
        let now = Utc::now();
        let key = close_task_key(position_id, kind);
        let mut g = self.inner.write();
        if let Some(existing) = g.close_tasks.get_mut(&key) {
            existing.fail_count += 1;
            existing.last_error = Some(err.to_string());
            let sec = (1 << existing.fail_count.min(7)).min(120).max(2);
            existing.next_retry_at = now
                .checked_add_signed(chrono::Duration::seconds(i64::from(sec)))
                .unwrap_or(now)
                .to_rfc3339();
            existing.last_attempt_at = Some(now.to_rfc3339());
        } else {
            g.close_tasks.insert(
                key,
                CloseTask {
                    position_id: position_id.to_string(),
                    kind: kind.to_string(),
                    fail_count: 1,
                    last_error: Some(err.to_string()),
                    next_retry_at: now.to_rfc3339(),
                    created_at: now.to_rfc3339(),
                    last_attempt_at: Some(now.to_rfc3339()),
                },
            );
        }
        drop(g);
        self.persist_spawn();
    }

    pub fn remove_close_task(&self, position_id: &str, kind: &str) {
        self.inner
            .write()
            .close_tasks
            .remove(&close_task_key(position_id, kind));
        self.persist_spawn();
    }

    pub fn list_close_tasks(&self) -> Vec<CloseTask> {
        self.inner.read().close_tasks.values().cloned().collect()
    }

    pub fn list_close_tasks_ready(&self) -> Vec<CloseTask> {
        let now = Utc::now();
        self.inner
            .read()
            .close_tasks
            .values()
            .filter(|t| {
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&t.next_retry_at) {
                    return dt.with_timezone(&Utc) <= now;
                }
                true
            })
            .cloned()
            .collect()
    }
}

pub struct RiskPatch {
    pub default_stop_trail_pct: Option<f64>,
    pub min_tick_debounce_ms: Option<i32>,
}

fn close_task_key(position_id: &str, kind: &str) -> String {
    format!("{}|{}", position_id.trim(), kind)
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            risk: RiskConfig::default(),
            by_id: HashMap::new(),
            risk_keys: HashMap::new(),
            close_tasks: HashMap::new(),
        }
    }
}

impl Inner {
    fn from_file(f: PositionsStateFile) -> Self {
        let mut by_id = HashMap::new();
        for p in f.positions {
            by_id.insert(p.id.clone(), p);
        }
        let mut risk_keys = HashMap::new();
        for k in f.risk_keys {
            if !k.is_empty() {
                risk_keys.insert(k, ());
            }
        }
        let mut close_tasks = HashMap::new();
        for ct in f.close_tasks {
            close_tasks.insert(close_task_key(&ct.position_id, &ct.kind), ct);
        }
        Self {
            risk: if f.risk.default_stop_trail_pct > 0.0 || f.risk.min_tick_debounce_ms > 0 {
                f.risk
            } else {
                RiskConfig::default()
            },
            by_id,
            risk_keys,
            close_tasks,
        }
    }

    fn to_payload(&self) -> PositionsStateFile {
        PositionsStateFile {
            schema: Some(STATE_SCHEMA.into()),
            risk: self.risk.clone(),
            positions: self.by_id.values().cloned().collect(),
            risk_keys: self.risk_keys.keys().cloned().collect(),
            close_tasks: self.close_tasks.values().cloned().collect(),
        }
    }
}

impl Default for PositionsStateFile {
    fn default() -> Self {
        Self {
            schema: Some(STATE_SCHEMA.into()),
            risk: RiskConfig::default(),
            positions: vec![],
            risk_keys: vec![],
            close_tasks: vec![],
        }
    }
}

pub fn new_position_from_register(
    req: &crate::models::RegisterPositionRequest,
    default_trail: f64,
) -> Position {
    let paper = req.paper.unwrap_or(false);
    let trail = if req.stop_trail_pct > 0.0 {
        req.stop_trail_pct
    } else {
        default_trail
    };
    let now = Utc::now().to_rfc3339();
    Position {
        id: req.id.clone().unwrap_or_default(),
        market_id: req.market_id.clone(),
        condition_id: req
            .condition_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        event_id: req
            .event_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        token_id: req.token_id.clone(),
        shares: req.shares,
        avg_entry_price: req.avg_entry_price,
        cost_usdc: req.cost_usdc,
        stop_trail_pct: trail,
        outcome_label: req
            .outcome_label
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        state: "open".into(),
        high_water_mark: req.avg_entry_price,
        monitoring_active: false,
        paper,
        external: false,
        auto_registered: false,
        game_start_at: None,
        created_at: now.clone(),
        updated_at: now,
    }
}
