package accounts

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	polyauth "github.com/drinkthere/polymarket-sdk/polymarket/auth"
	"github.com/drinkthere/polymarket-sdk/polymarket/httpx"
	"github.com/drinkthere/polyserver/internal/models"
	"github.com/drinkthere/polyserver/internal/storage"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
	"github.com/sirupsen/logrus"
)

const schemaDerivedCredentialsV1 = "derived-credentials-v1"
const polygonChainID = 137
const gnosisSafeSignatureType = 3

// CLOBAuthHTTPTimeout is the httpx client timeout for Polymarket CLOB L1 auth
// (create/derive API key) during account import. Override with env CLOB_AUTH_TIMEOUT_SEC.
func CLOBAuthHTTPTimeout() time.Duration {
	const defaultSec = 90
	const minSec = 15
	const maxSec = 300
	sec := defaultSec
	if raw := strings.TrimSpace(os.Getenv("CLOB_AUTH_TIMEOUT_SEC")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			sec = n
		}
	}
	if sec < minSec {
		sec = minSec
	}
	if sec > maxSec {
		sec = maxSec
	}
	return time.Duration(sec) * time.Second
}

// CreateAccountRequestTimeout is the HTTP handler budget for create-account:
// CLOB auth plus persist, balance, and portfolio calls.
func CreateAccountRequestTimeout() time.Duration {
	// Headroom beyond CLOB client timeout for disk IO and follow-up RPCs.
	return CLOBAuthHTTPTimeout() + 90*time.Second
}

// newClobAuthHTTPClient builds the net/http client used for CLOB L1 auth.
// If outboundProxyURL is non-empty (e.g. global-params proxyUrl), it is used
// as the HTTP CONNECT proxy; otherwise ProxyFromEnvironment applies (HTTPS_PROXY,
// https_proxy, NO_PROXY, etc.), matching curl and the rest of the Go stdlib.
func newClobAuthHTTPClient(outboundProxyURL string) (*http.Client, error) {
	var tr *http.Transport
	if dt, ok := http.DefaultTransport.(*http.Transport); ok {
		tr = dt.Clone()
	} else {
		tr = &http.Transport{Proxy: http.ProxyFromEnvironment}
	}
	if p := strings.TrimSpace(outboundProxyURL); p != "" {
		u, err := url.Parse(p)
		if err != nil {
			return nil, fmt.Errorf("invalid outbound proxy URL: %w", err)
		}
		if !u.IsAbs() || strings.TrimSpace(u.Host) == "" {
			return nil, fmt.Errorf("invalid outbound proxy URL: need absolute URL with host")
		}
		tr.Proxy = http.ProxyURL(u)
	}
	return &http.Client{
		Transport: tr,
		Timeout:   CLOBAuthHTTPTimeout(),
	}, nil
}

// Store keeps account records compatible with the Rust backend.
type Store struct {
	path       string
	legacyPath string
	mu         sync.RWMutex
	file       models.AccountsFile
}

// Load reads derived-credentials.json or falls back to legacy accounts.json.
func Load(ctx context.Context, path, legacyPath string) (*Store, error) {
	s := &Store{path: path, legacyPath: legacyPath}
	readPath := path
	if _, err := os.Stat(readPath); errors.Is(err, os.ErrNotExist) && legacyPath != "" {
		if _, legacyErr := os.Stat(legacyPath); legacyErr == nil {
			readPath = legacyPath
			logrus.WithFields(logrus.Fields{
				"component": "accounts",
				"path":      legacyPath,
			}).Info("loading legacy accounts file")
		}
	}
	if err := storage.LoadJSON(ctx, readPath, &s.file); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component": "accounts",
			"path":      readPath,
		}).Error("accounts load failed")
		return nil, err
	}
	logrus.WithFields(logrus.Fields{
		"component":  "accounts",
		"path":       readPath,
		"count":      len(s.file.Accounts),
		"default_id": s.file.DefaultID,
	}).Info("accounts loaded")
	return s, nil
}

// Snapshot returns the default id and a copy of all accounts.
func (s *Store) Snapshot() (string, []models.AccountRecord) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := append([]models.AccountRecord(nil), s.file.Accounts...)
	return s.file.DefaultID, out
}

// Default returns the configured default account.
func (s *Store) Default() (models.AccountRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, rec := range s.file.Accounts {
		if rec.ID == s.file.DefaultID {
			return rec, true
		}
	}
	return models.AccountRecord{}, false
}

// Add persists a newly derived account and assigns the next local account id.
func (s *Store) Add(ctx context.Context, rec models.AccountRecord) (models.AccountRecord, error) {
	if strings.TrimSpace(rec.ID) == "" {
		rec.ID = newAccountID()
	}
	if strings.TrimSpace(rec.Label) == "" {
		rec.Label = "account"
	}
	if strings.TrimSpace(rec.DerivedAt) == "" {
		rec.DerivedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}

	s.mu.Lock()
	maxID := -1
	for _, existing := range s.file.Accounts {
		if existing.AccountID > maxID {
			maxID = existing.AccountID
		}
	}
	rec.AccountID = maxID + 1
	if strings.TrimSpace(s.file.DefaultID) == "" {
		s.file.DefaultID = rec.ID
	}
	s.file.Accounts = append(s.file.Accounts, rec)
	defaultID := s.file.DefaultID
	s.mu.Unlock()

	if err := s.persist(ctx); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": rec.ID,
		}).Error("add account persist failed")
		return models.AccountRecord{}, err
	}
	logrus.WithFields(logrus.Fields{
		"component":       "accounts",
		"account_id":      rec.ID,
		"local_index":     rec.AccountID,
		"eoa_address":     rec.EOAAddress,
		"proxy_address":   rec.ProxyWalletAddress,
		"default_id":      defaultID,
		"has_clob_creds":  rec.HasCLOBCredentials(),
		"signature_type":  gnosisSafeSignatureType,
		"polygon_chainID": polygonChainID,
	}).Info("account added")
	return rec, nil
}

// SetDefault updates the default account id.
func (s *Store) SetDefault(ctx context.Context, id string) error {
	s.mu.Lock()
	found := false
	for _, rec := range s.file.Accounts {
		if rec.ID == id {
			found = true
			break
		}
	}
	if !found {
		s.mu.Unlock()
		logrus.WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": id,
		}).Warn("set default rejected: account not found")
		return fmt.Errorf("account not found")
	}
	s.file.DefaultID = id
	s.mu.Unlock()
	if err := s.persist(ctx); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": id,
		}).Error("set default persist failed")
		return err
	}
	logrus.WithFields(logrus.Fields{
		"component":  "accounts",
		"account_id": id,
	}).Info("default account persisted")
	return nil
}

// Delete removes an account by id.
func (s *Store) Delete(ctx context.Context, id string) error {
	s.mu.Lock()
	next := s.file.Accounts[:0]
	removed := false
	for _, rec := range s.file.Accounts {
		if rec.ID == id {
			removed = true
			continue
		}
		next = append(next, rec)
	}
	s.file.Accounts = next
	if s.file.DefaultID == id {
		s.file.DefaultID = ""
		if len(s.file.Accounts) > 0 {
			s.file.DefaultID = s.file.Accounts[0].ID
		}
	}
	s.mu.Unlock()
	if !removed {
		logrus.WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": id,
		}).Warn("delete rejected: account not found")
		return fmt.Errorf("account not found")
	}
	if err := s.persist(ctx); err != nil {
		logrus.WithError(err).WithFields(logrus.Fields{
			"component":  "accounts",
			"account_id": id,
		}).Error("delete account persist failed")
		return err
	}
	logrus.WithFields(logrus.Fields{
		"component":      "accounts",
		"account_id":     id,
		"new_default_id": s.file.DefaultID,
	}).Info("account delete persisted")
	return nil
}

// DeriveAccountRecordWithCLOB follows the Rust backend flow:
// EVM private key -> EOA -> deterministic Polymarket Safe -> CLOB L2 credentials.
// outboundProxyURL is the same optional HTTP proxy URL as global-params proxyUrl;
// when empty, HTTPS_PROXY / HTTP_PROXY from the process environment are used.
func DeriveAccountRecordWithCLOB(ctx context.Context, label *string, evmPrivateKey string, outboundProxyURL string) (models.AccountRecord, error) {
	pk, err := normalizePrivateKeyHex(evmPrivateKey)
	if err != nil {
		return models.AccountRecord{}, err
	}
	privateKey, err := ethcrypto.HexToECDSA(strings.TrimPrefix(pk, "0x"))
	if err != nil {
		return models.AccountRecord{}, fmt.Errorf("invalid evm private key: %w", err)
	}
	eoa := ethcrypto.PubkeyToAddress(privateKey.PublicKey)
	eoaHex := strings.ToLower(eoa.Hex())

	proxy := eoa
	if derived, deriveErr := polyauth.DeriveSafeWallet(eoa, polygonChainID); deriveErr == nil {
		proxy = derived
	} else {
		logrus.WithError(deriveErr).WithFields(logrus.Fields{
			"component":   "accounts",
			"eoa_address": eoaHex,
		}).Warn("derive safe wallet failed; falling back to EOA")
	}
	proxyHex := strings.ToLower(proxy.Hex())

	clobURL := strings.TrimSpace(os.Getenv("CLOB_API_URL"))
	if clobURL == "" {
		clobURL = "https://clob.polymarket.com"
	}
	rawHTTP, err := newClobAuthHTTPClient(outboundProxyURL)
	if err != nil {
		return models.AccountRecord{}, err
	}
	transport, err := httpx.NewWithHTTPClient(httpx.ClientConfig{
		BaseURL: clobURL,
		Timeout: CLOBAuthHTTPTimeout(),
	}, rawHTTP)
	if err != nil {
		return models.AccountRecord{}, fmt.Errorf("clob client: %w", err)
	}
	authClient, err := polyauth.NewClient(transport, polyauth.Config{
		PrivateKey:    pk,
		FunderAddress: proxyHex,
		ChainID:       polygonChainID,
		SignatureType: gnosisSafeSignatureType,
	})
	if err != nil {
		return models.AccountRecord{}, fmt.Errorf("clob auth client: %w", err)
	}
	creds, err := authClient.CreateOrDeriveAPIKey(ctx, 0)
	if err != nil {
		return models.AccountRecord{}, fmt.Errorf("derive CLOB API key: %w", err)
	}
	if !creds.Valid() {
		return models.AccountRecord{}, fmt.Errorf("derive CLOB API key: empty credentials")
	}

	accountLabel := "account"
	if label != nil && strings.TrimSpace(*label) != "" {
		accountLabel = strings.TrimSpace(*label)
	}
	rec := models.AccountRecord{
		ID:                 newAccountID(),
		AccountID:          0,
		Label:              accountLabel,
		EVMPrivateKey:      pk,
		EOAAddress:         eoaHex,
		ProxyWalletAddress: proxyHex,
		APIKey:             creds.Key,
		APISecret:          creds.Secret,
		APIPassphrase:      creds.Passphrase,
		DerivedAt:          time.Now().UTC().Format(time.RFC3339Nano),
	}
	logrus.WithFields(logrus.Fields{
		"component":              "accounts",
		"account_id":             rec.ID,
		"eoa_address":            rec.EOAAddress,
		"proxy_address":          rec.ProxyWalletAddress,
		"has_clob_creds":         rec.HasCLOBCredentials(),
		"clob_url":               clobURL,
		"outbound_proxy_explicit": strings.TrimSpace(outboundProxyURL) != "",
	}).Info("account derived")
	return rec, nil
}

func normalizePrivateKeyHex(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimPrefix(strings.TrimPrefix(trimmed, "0x"), "0X")
	if trimmed == "" {
		return "", fmt.Errorf("evm private key is required")
	}
	if len(trimmed) != 64 {
		return "", fmt.Errorf("invalid evm private key length")
	}
	if _, err := hex.DecodeString(trimmed); err != nil {
		return "", fmt.Errorf("invalid evm private key hex: %w", err)
	}
	return "0x" + strings.ToLower(trimmed), nil
}

func newAccountID() string {
	var b [16]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		return strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	}
	return hex.EncodeToString(b[:])
}

func (s *Store) persist(ctx context.Context) error {
	s.mu.RLock()
	file := s.file
	file.Accounts = append([]models.AccountRecord(nil), s.file.Accounts...)
	schema := schemaDerivedCredentialsV1
	file.Schema = &schema
	s.mu.RUnlock()
	logrus.WithFields(logrus.Fields{
		"component": "accounts",
		"path":      s.path,
		"count":     len(file.Accounts),
	}).Debug("accounts persist started")
	return storage.SaveJSONAtomic(ctx, s.path, file)
}

// View converts account data to the frontend response shape.
func View(rec models.AccountRecord, defaultID string, usdcBalance, portfolioValue float64, note string) models.AccountView {
	var proxy *string
	if rec.ProxyWalletAddress != "" {
		v := rec.ProxyWalletAddress
		proxy = &v
	}
	return models.AccountView{
		ID:                 rec.ID,
		Label:              rec.Label,
		EOAAddress:         rec.EOAAddress,
		ProxyWalletAddress: proxy,
		IsDefault:          rec.ID == defaultID,
		USDCBalance:        usdcBalance,
		PortfolioValue:     portfolioValue,
		BalanceNote:        note,
		HasCLOBCredentials: rec.HasCLOBCredentials(),
	}
}
