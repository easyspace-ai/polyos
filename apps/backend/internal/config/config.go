package config

import (
	"os"
	"path/filepath"
	"strconv"
)

// Config contains runtime paths and network binding settings compatible with the Rust backend.
type Config struct {
	Host    string
	Port    int
	DataDir string
	WebDir  string
}

// FromEnv loads configuration from POLYBACKEND_* and PORT environment variables.
func FromEnv() Config {
	dataDir := envOr("POLYBACKEND_DATA_DIR", "./data")
	webDir := envOr("POLYBACKEND_WEB_DIR", filepath.Join(dataDir, "web"))
	port := 6666
	if raw := firstEnv("POLYBACKEND_PORT", "PORT"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			port = parsed
		}
	}
	return Config{
		Host:    envOr("POLYBACKEND_HOST", "0.0.0.0"),
		Port:    port,
		DataDir: dataDir,
		WebDir:  webDir,
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if v := os.Getenv(key); v != "" {
			return v
		}
	}
	return ""
}

// AccountsPath returns the Rust-compatible account credentials path.
func (c Config) AccountsPath() string { return filepath.Join(c.DataDir, "derived-credentials.json") }

// LegacyAccountsPath returns the old account file path accepted by the Rust backend.
func (c Config) LegacyAccountsPath() string { return filepath.Join(c.DataDir, "accounts.json") }

// LeaguesPath returns the league configuration path.
func (c Config) LeaguesPath() string { return filepath.Join(c.DataDir, "leagues.json") }

// TeamsPath returns the team mapping path.
func (c Config) TeamsPath() string { return filepath.Join(c.DataDir, "teams.json") }

// PositionsStatePath returns the persisted monitor position state path.
func (c Config) PositionsStatePath() string { return filepath.Join(c.DataDir, "positions-state.json") }

// GlobalParamsPath returns the persisted UI global params path.
func (c Config) GlobalParamsPath() string { return filepath.Join(c.DataDir, "global-params.json") }

// HomeMarketsCachePath returns the persisted home market discovery cache path.
func (c Config) HomeMarketsCachePath() string {
	return filepath.Join(c.DataDir, "home-markets-cache.json")
}

// HistoryDBPath returns the closed trade history sqlite path.
func (c Config) HistoryDBPath() string { return filepath.Join(c.DataDir, "trade-history.sqlite") }
