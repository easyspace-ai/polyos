use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub web_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Self {
        let data_dir = std::env::var("POLYBACKEND_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./data"));
        let host = std::env::var("POLYBACKEND_HOST").unwrap_or_else(|_| "0.0.0.0".into());
        let web_dir = std::env::var("POLYBACKEND_WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| data_dir.join("web"));
        // Prefer explicit backend port; `PORT` is what Electron sets when spawning the child process.
        let port = std::env::var("POLYBACKEND_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .or_else(|| std::env::var("PORT").ok().and_then(|s| s.parse().ok()))
            .unwrap_or(6666);
        Self {
            host,
            port,
            data_dir,
            web_dir,
        }
    }

    /// Same filename as Go backend (`internal/config`): `data/derived-credentials.json`.
    pub fn accounts_path(&self) -> PathBuf {
        self.data_dir.join("derived-credentials.json")
    }

    pub fn leagues_path(&self) -> PathBuf {
        self.data_dir.join("leagues.json")
    }

    pub fn teams_path(&self) -> PathBuf {
        self.data_dir.join("teams.json")
    }

    pub fn positions_state_path(&self) -> PathBuf {
        self.data_dir.join("positions-state.json")
    }

    pub fn history_db_path(&self) -> PathBuf {
        self.data_dir.join("trade-history.sqlite")
    }

    pub fn global_params_path(&self) -> PathBuf {
        self.data_dir.join("global-params.json")
    }

    pub fn web_dir(&self) -> PathBuf {
        self.web_dir.clone()
    }
}
