use std::path::Path;
use std::str::FromStr;

use alloy::signers::Signer as _;
use alloy::signers::local::PrivateKeySigner;
use anyhow::Context;
use chrono::Utc;
use parking_lot::RwLock;
use polymarket_client_sdk_v2::clob::{Client as ClobClient, Config as ClobConfig};
use polymarket_client_sdk_v2::{POLYGON, derive_safe_wallet};
use secrecy::ExposeSecret as _;

use crate::models::{AccountRecord, AccountView, AccountsFile};

const SCHEMA_DERIVED_CREDENTIALS_V1: &str = "derived-credentials-v1";

pub struct AccountStore {
    /// Primary path: `derived-credentials.json` (same as Go). Writes always go here.
    path: std::path::PathBuf,
    inner: RwLock<AccountsFile>,
}

impl AccountStore {
    pub async fn load(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(p) = path.parent() {
            tokio::fs::create_dir_all(p).await.ok();
        }
        let legacy = path.with_file_name("accounts.json");
        let read_path = if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            Some(path.clone())
        } else if tokio::fs::try_exists(&legacy).await.unwrap_or(false) {
            Some(legacy)
        } else {
            None
        };
        let inner = if let Some(rp) = read_path {
            let raw = tokio::fs::read_to_string(&rp).await?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            AccountsFile::default()
        };
        Ok(Self {
            path,
            inner: RwLock::new(inner),
        })
    }

    pub fn snapshot(&self) -> (String, Vec<AccountRecord>) {
        let g = self.inner.read();
        (g.default_id.clone(), g.accounts.clone())
    }

    pub fn default_record(&self) -> Option<AccountRecord> {
        let g = self.inner.read();
        let id = g.default_id.trim();
        g.accounts.iter().find(|a| a.id == id).cloned()
    }

    pub async fn add(&self, mut rec: AccountRecord) -> anyhow::Result<AccountRecord> {
        {
            let mut g = self.inner.write();
            let max_id = g.accounts.iter().map(|a| a.account_id).max().unwrap_or(-1);
            rec.account_id = max_id + 1;
            if rec.derived_at.trim().is_empty() {
                rec.derived_at = Utc::now().to_rfc3339();
            }
            if g.default_id.is_empty() {
                g.default_id.clone_from(&rec.id);
            }
            g.accounts.push(rec.clone());
        }
        self.persist().await?;
        Ok(rec)
    }

    pub async fn remove(&self, id: &str) -> anyhow::Result<()> {
        {
            let mut g = self.inner.write();
            g.accounts.retain(|a| a.id != id);
            if g.default_id == id {
                g.default_id = g.accounts.first().map(|a| a.id.clone()).unwrap_or_default();
            }
        }
        self.persist().await?;
        Ok(())
    }

    pub async fn set_default(&self, id: &str) -> anyhow::Result<()> {
        {
            let mut g = self.inner.write();
            if !g.accounts.iter().any(|a| a.id == id) {
                anyhow::bail!("account not found");
            }
            g.default_id = id.to_string();
        }
        self.persist().await?;
        Ok(())
    }

    /// Overwrite `proxy_wallet_address` with the Polymarket CREATE2 Gnosis Safe for this account's EVM key.
    pub async fn sync_derived_proxy_for_account(&self, id: &str) -> anyhow::Result<AccountRecord> {
        let updated = {
            let mut g = self.inner.write();
            let Some(rec) = g.accounts.iter_mut().find(|a| a.id == id) else {
                anyhow::bail!("account not found");
            };
            let new_proxy = expected_proxy_wallet_hex(&rec.evm_private_key)?;
            if !rec.proxy_wallet_address.eq_ignore_ascii_case(&new_proxy) {
                tracing::info!(
                    account_id = %id,
                    old = %rec.proxy_wallet_address,
                    new = %new_proxy,
                    "synced proxy_wallet_address from derived Safe"
                );
            }
            rec.proxy_wallet_address = new_proxy;
            rec.clone()
        };
        self.persist().await?;
        Ok(updated)
    }

    async fn persist(&self) -> anyhow::Result<()> {
        let b = {
            let g = self.inner.read();
            let mut file = g.clone();
            file.schema = Some(SCHEMA_DERIVED_CREDENTIALS_V1.into());
            serde_json::to_vec_pretty(&file).context("serialize accounts")?
        };
        let tmp = self.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, &b).await?;
        tokio::fs::rename(&tmp, &self.path).await?;
        Ok(())
    }
}

/// Normalize EVM private key hex like Go `normalizeHexKey` (`0x` + lowercase).
fn normalize_pk_hex(raw: &str) -> anyhow::Result<String> {
    let s = raw.trim();
    let hex_body = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    anyhow::ensure!(!hex_body.is_empty(), "empty private key");
    Ok(format!("0x{}", hex_body.to_lowercase()))
}

/// Expected Polymarket proxy (Gnosis Safe) hex for `evm_private_key`, or EOA hex if derivation is unavailable.
pub fn expected_proxy_wallet_hex(evm_private_key: &str) -> anyhow::Result<String> {
    let pk = normalize_pk_hex(evm_private_key)?;
    let signer = PrivateKeySigner::from_str(pk.trim())
        .context("invalid evm private key")?
        .with_chain_id(Some(POLYGON));
    let eoa_hex = format!("{:#x}", signer.address());
    Ok(derive_safe_wallet(signer.address(), POLYGON)
        .map(|a| format!("{a:#x}"))
        .unwrap_or(eoa_hex))
}

/// Create a new account row: EOA from key, **Polymarket Gnosis Safe** `proxy_address` via CREATE2,
/// and CLOB L2 credentials via `create_or_derive_api_key` (same idea as Go `DeriveTradingAccount`).
pub async fn derive_account_record_with_clob(
    label: Option<String>,
    evm_private_key: &str,
) -> anyhow::Result<AccountRecord> {
    let pk = normalize_pk_hex(evm_private_key)?;
    let signer = PrivateKeySigner::from_str(pk.trim())
        .context("invalid evm private key")?
        .with_chain_id(Some(POLYGON));
    let eoa_hex = format!("{:#x}", signer.address());

    let host =
        std::env::var("CLOB_API_URL").unwrap_or_else(|_| "https://clob.polymarket.com".into());
    let client = ClobClient::new(host.trim(), ClobConfig::default()).context("clob client")?;
    let creds = client
        .create_or_derive_api_key(&signer, None)
        .await
        .map_err(|e| anyhow::anyhow!("derive CLOB API key: {e}"))?;

    let api_key = creds.key().to_string();
    let api_secret = creds.secret().expose_secret().to_string();
    let api_passphrase = creds.passphrase().expose_secret().to_string();

    let proxy_wallet_address = derive_safe_wallet(signer.address(), POLYGON)
        .map(|a| format!("{a:#x}"))
        .unwrap_or_else(|| {
            tracing::warn!("derive_safe_wallet failed; falling back to EOA as proxy — Data API may not list positions");
            eoa_hex.clone()
        });

    Ok(AccountRecord {
        id: uuid::Uuid::new_v4().simple().to_string(),
        account_id: 0,
        label: label.unwrap_or_else(|| "account".into()),
        evm_private_key: pk,
        eoa_address: eoa_hex,
        proxy_wallet_address,
        api_key,
        api_secret,
        api_passphrase,
        derived_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    })
}

pub fn account_view(
    r: &AccountRecord,
    default_id: &str,
    usdc_balance: f64,
    portfolio: f64,
    note: &str,
    has_clob: bool,
) -> AccountView {
    AccountView {
        id: r.id.clone(),
        label: r.label.clone(),
        eoa_address: r.eoa_address.clone(),
        proxy_wallet_address: if r.proxy_wallet_address.trim().is_empty() {
            None
        } else {
            Some(r.proxy_wallet_address.clone())
        },
        is_default: r.id == default_id,
        usdc_balance,
        portfolio_value: portfolio,
        balance_note: note.to_string(),
        has_clob_credentials: has_clob,
    }
}
