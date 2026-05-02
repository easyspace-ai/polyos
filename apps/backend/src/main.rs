use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::sync::broadcast;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use polybackend::accounts::AccountStore;
use polybackend::app::{AppState, HomeMarketsCache};
use polybackend::board::BoardDeps;
use polybackend::config::Config;
use polybackend::global_params::GlobalParamsStore;
use polybackend::history_db::HistoryDb;
use polybackend::http::router;
use polybackend::leagues;
use polybackend::monitor_feed;
use polybackend::positions_store::PositionStore;
use polybackend::risk_engine::PriceBook;
use polybackend::trading::TradingService;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cfg = Config::from_env();

    // -- logging setup (console + daily rolling file) --
    let log_dir = cfg.data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = tracing_appender::rolling::RollingFileAppender::new(
        tracing_appender::rolling::Rotation::DAILY,
        &log_dir,
        "polybackend",
    );
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = tracing_subscriber::EnvFilter::from_default_env()
        .add_directive("polybackend=info".parse()?)
        .add_directive("tower_http=info".parse()?);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stdout)
                .with_ansi(true),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false),
        )
        .init();

    let leagues = leagues::load_leagues(cfg.leagues_path()).await?;
    let teams = polybackend::board::load_teams(&cfg.teams_path()).await;
    let mut board = BoardDeps::new()?;
    board.teams = teams;

    let positions = Arc::new(PositionStore::load_or_create(cfg.positions_state_path()).await?);
    let accounts = Arc::new(AccountStore::load(cfg.accounts_path()).await?);
    let global_params = Arc::new(GlobalParamsStore::load(cfg.global_params_path()).await?);
    let history = match HistoryDb::connect(&cfg.history_db_path()).await {
        Ok(h) => Some(Arc::new(h)),
        Err(e) => {
            tracing::warn!(?e, "history db disabled");
            None
        }
    };
    let (mon_tx, _) = broadcast::channel(256);
    let (board_tx, _) = broadcast::channel(256);
    let app = Arc::new(AppState {
        cfg: cfg.clone(),
        global_params,
        leagues,
        board: Arc::new(board),
        positions,
        accounts,
        trading: Arc::new(TradingService::new()),
        history,
        prices: Arc::new(PriceBook::new()),
        monitor_broadcast: mon_tx,
        board_broadcast: board_tx,
        board_regs: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        chain_sync_status: Arc::new(parking_lot::Mutex::new(
            polybackend::app::ChainSyncStatus::default(),
        )),
        home_markets_cache: Arc::new(HomeMarketsCache::new()),
        monitor_last_broadcast_at: parking_lot::Mutex::new(None),
    });

    monitor_feed::spawn_close_queue_loop(app.clone());
    monitor_feed::spawn_chain_sync_loop(app.clone());
    let _ = monitor_feed::start_price_poll(app.clone());
    monitor_feed::spawn_clob_user_events_loop(app.clone());

    let r = router(app.clone());
    let addr: SocketAddr = format!("{}:{}", cfg.host, cfg.port).parse()?;
    tracing::info!(%addr, "polybackend listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, r).await?;
    Ok(())
}
