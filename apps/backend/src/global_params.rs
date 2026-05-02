//! UI global params (same JSON shape as frontend `GlobalParams`), persisted under `data/global-params.json`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// One A/B/C tier row (camelCase JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierConfigRow {
    pub id: String,
    pub label: String,
    pub min: f64,
    pub max: f64,
    pub alloc_pct: f64,
    pub default_stop_loss: f64,
}

/// Mirrors `apps/frontend/src/lib/types.ts` `GlobalParams`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalParams {
    pub daily_budget_pct: f64,
    /// 链上 / 外部 API 同步进来的仓位：移动止损默认比例（0–100 的百分数，如 20 = 20%）
    #[serde(default = "default_external_stop_loss_pct")]
    pub external_default_stop_loss_pct: f64,
    pub max_spread: f64,
    pub min_depth_multiplier: f64,
    pub tiers: Vec<TierConfigRow>,
    pub leagues: Vec<String>,
}

fn default_external_stop_loss_pct() -> f64 {
    20.0
}

/// If tier bounds were saved as **cents** (e.g. 50–60) instead of probabilities (0.5–0.6), normalize to 0–1.
fn normalize_tier_price_bounds(gp: &mut GlobalParams) {
    let looks_like_cents = gp.tiers.iter().any(|t| t.min > 1.0 || t.max > 1.01);
    if !looks_like_cents {
        return;
    }
    for t in &mut gp.tiers {
        if t.min > 1.0 || t.max > 1.01 {
            t.min /= 100.0;
            t.max /= 100.0;
        }
    }
}

impl Default for GlobalParams {
    fn default() -> Self {
        Self {
            daily_budget_pct: 30.0,
            external_default_stop_loss_pct: 20.0,
            max_spread: 0.05,
            min_depth_multiplier: 3.0,
            leagues: vec!["NBA".into(), "NCAAB".into(), "NHL".into()],
            tiers: vec![
                TierConfigRow {
                    id: "A".into(),
                    label: "高赔率区间".into(),
                    min: 0.05,
                    max: 0.25,
                    alloc_pct: 50.0,
                    default_stop_loss: 30.0,
                },
                TierConfigRow {
                    id: "B".into(),
                    label: "中赔率区间".into(),
                    min: 0.25,
                    max: 0.55,
                    alloc_pct: 30.0,
                    default_stop_loss: 20.0,
                },
                TierConfigRow {
                    id: "C".into(),
                    label: "低赔率区间".into(),
                    min: 0.55,
                    max: 0.85,
                    alloc_pct: 20.0,
                    default_stop_loss: 15.0,
                },
            ],
        }
    }
}

pub struct GlobalParamsStore {
    path: PathBuf,
    inner: RwLock<GlobalParams>,
}

impl GlobalParamsStore {
    pub async fn load(path: PathBuf) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        let exists = tokio::fs::try_exists(&path).await.unwrap_or(false);
        let inner = if exists {
            let raw = tokio::fs::read_to_string(&path).await?;
            let mut v: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
            if let Some(obj) = v.as_object_mut() {
                if !obj.contains_key("externalDefaultStopLossPct") {
                    let legacy = obj
                        .get("defaultStopLossPct")
                        .and_then(|x| x.as_f64())
                        .unwrap_or(20.0);
                    obj.insert(
                        "externalDefaultStopLossPct".into(),
                        serde_json::json!(legacy),
                    );
                }
            }
            let mut gp: GlobalParams = serde_json::from_value(v).unwrap_or_default();
            normalize_tier_price_bounds(&mut gp);
            gp
        } else {
            GlobalParams::default()
        };
        let s = Self {
            path,
            inner: RwLock::new(inner),
        };
        if !exists {
            s.persist().await?;
        }
        Ok(s)
    }

    pub async fn get(&self) -> GlobalParams {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, mut p: GlobalParams) -> anyhow::Result<()> {
        normalize_tier_price_bounds(&mut p);
        *self.inner.write().await = p;
        self.persist().await
    }

    async fn persist(&self) -> anyhow::Result<()> {
        let p = self.inner.read().await.clone();
        let b = serde_json::to_vec_pretty(&p)?;
        let tmp = self.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &b).await?;
        tokio::fs::rename(&tmp, &self.path).await?;
        Ok(())
    }
}
