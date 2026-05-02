import type { Market } from "./types";
import { getTierForPrice } from "./calc";
import type { GlobalParams } from "./types";
import { useWalletStore } from "./store";

const rawBackend = import.meta.env.VITE_BACKEND_BASE_URL;

/**
 * When VITE_BACKEND_BASE_URL is unset, use same-origin relative requests.
 * In dev, Vite proxy forwards these paths to backend:6666, avoiding mixed-content/CORS issues.
 */
export const BACKEND_BASE =
  typeof rawBackend === "string" && rawBackend.trim() !== ""
    ? rawBackend.trim().replace(/\/+$/, "")
    : "";

const DEFAULT_FETCH_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** WebSocket base (http→ws, https→wss) for `/ws/board` live CLOB ticks. */
export function wsBoardURL(): string {
  const b = BACKEND_BASE.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  return `${b.replace(/\/$/, "")}/ws/board`;
}

/** WebSocket for `/ws/monitor` portfolio snapshots (same payload as GET /monitor/snapshot). */
export function wsMonitorURL(): string {
  const b = BACKEND_BASE.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  return `${b.replace(/\/$/, "")}/ws/monitor`;
}

interface HomeMarketItem {
  id: string;
  conditionId?: string;
  eventId?: string;
  eventSlug?: string;
  question: string;
  league: "NBA" | "NCAAB" | "NHL";
  startTime: string;
  yesTokenId?: string;
  noTokenId?: string;
  openPrice: number;
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
  bidDepth: number;
  askDepth: number;
  volume24h?: number;
  polymarketUrl?: string;
  chineseSubtitle?: string;
}

interface HomeMarketsResponse {
  success: boolean;
  data: {
    markets: HomeMarketItem[];
  };
  timestamp: string;
  cached: boolean;
}

/**
 * 拉取 Polymarket 中正在进行 / 即将开始的篮球类赛事行情。
 * 使用 gamma-api 公开只读接口。
 */
export async function fetchBasketballMarkets(
  params: GlobalParams,
  prevOpenPrices: Record<string, number> = {},
): Promise<Market[]> {
  const groups = await Promise.all(
    params.leagues.map(async (league) => {
      const rows: Market[] = [];
      const qs = new URLSearchParams();
      qs.set("league", league);
      qs.set("status", "active");
      // Aligns date= filtering with poly-nba-markets when you pass `date` later.
      qs.set("tz_offset", String(new Date().getTimezoneOffset()));
      const res = await fetchWithTimeout(
        `${BACKEND_BASE}/api/home/markets?${qs.toString()}`,
        {},
        18_000,
      );
      if (!res.ok) {
        throw new Error(`backend markets fetch failed (${res.status})`);
      }
      const body = (await res.json()) as HomeMarketsResponse;
      if (!body.success) {
        throw new Error("backend markets response not successful");
      }
      for (const r of body.data.markets) {
        const mid = Number(r.midPrice) || 0;
        const bestBid = Number(r.bestBid) || Math.max(0, mid - 0.01);
        const bestAsk = Number(r.bestAsk) || Math.min(1, mid + 0.01);
        const spread = Number(r.spread) || Math.max(0, bestAsk - bestBid);
        const tier = getTierForPrice(mid, params.tiers);
        const open = prevOpenPrices[r.id] ?? (Number(r.openPrice) || mid);
        rows.push({
          id: r.id,
          conditionId: r.conditionId,
          eventId: r.eventId,
          eventSlug: r.eventSlug,
          question: r.question,
          league: r.league,
          startTime: r.startTime ?? new Date().toISOString(),
          yesTokenId: r.yesTokenId,
          noTokenId: r.noTokenId,
          openPrice: open,
          bestBid,
          bestAsk,
          midPrice: mid,
          spread,
          bidDepth: Number(r.bidDepth) || 0,
          askDepth: Number(r.askDepth) || 0,
          volume24h: Number(r.volume24h) || 0,
          polymarketUrl: r.polymarketUrl,
          chineseSubtitle: r.chineseSubtitle,
          tier,
          suggestedAmount: 0,
        });
      }
      return rows;
    }),
  );

  // 保留全部 outcome，避免因 A/B/C 区间只命中一侧导致同场只剩一行
  return groups.flat();
}

// --- Paper trading (test tab) ---

export interface PaperOutcomeRef {
  tokenId: string;
  outcome: string;
}

export interface PaperResolvedMarket {
  marketId: string;
  question: string;
  outcomes: PaperOutcomeRef[];
}

export interface PaperResolveResponse {
  slug: string;
  eventId: string;
  title: string;
  markets: PaperResolvedMarket[];
}

export async function resolvePaperEvent(url: string): Promise<PaperResolveResponse> {
  const res = await fetch(`${BACKEND_BASE}/paper/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `resolve failed (${res.status})`);
  }
  return body as PaperResolveResponse;
}

export interface BackendPaperPosition {
  id: string;
  marketId: string;
  conditionId?: string;
  eventId?: string;
  tokenId: string;
  shares: number;
  avgEntryPrice: number;
  costUsdc: number;
  stopTrailPct: number;
  outcomeLabel?: string;
  state: string;
  highWaterMark: number;
  monitoringActive: boolean;
  paper?: boolean;
  external?: boolean;
}

export async function simulatePaperBuy(req: {
  marketId: string;
  eventId?: string;
  tokenId: string;
  usdc: number;
  stopTrailPct: number;
  arm: boolean;
}): Promise<BackendPaperPosition> {
  const res = await fetch(`${BACKEND_BASE}/paper/simulate-buy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      marketId: req.marketId,
      eventId: req.eventId,
      tokenId: req.tokenId,
      usdc: req.usdc,
      stopTrailPct: req.stopTrailPct,
      arm: req.arm,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `simulate-buy failed (${res.status})`);
  }
  return body as BackendPaperPosition;
}

export interface MonitorSnapshotPositionRow {
  id: string;
  marketId: string;
  eventId?: string;
  tokenId: string;
  shares: number;
  costUsdc: number;
  stopTrailPct: number;
  outcomeLabel?: string;
  state: string;
  monitoringActive: boolean;
  highWaterMark: number;
  bid?: number;
  ask?: number;
  mid?: number;
  unrealizedMidUsdc: number;
  paper?: boolean;
}

export interface MonitorSnapshot {
  totalCostUsdc: number;
  totalMarkValueBid: number;
  unrealizedMidUsdc: number;
  unrealizedPctMid: number;
  positions: MonitorSnapshotPositionRow[];
  risk: { defaultStopTrailPct: number };
  timestamp: string;
}

export async function fetchMonitorSnapshot(): Promise<MonitorSnapshot> {
  const res = await fetchWithTimeout(`${BACKEND_BASE}/monitor/snapshot`, {}, 6_000);
  if (!res.ok) {
    throw new Error(`snapshot failed (${res.status})`);
  }
  return res.json() as Promise<MonitorSnapshot>;
}

/** Pending CLOB MarketSell retries after risk-triggered exit failed (persisted on server). */
export interface MonitorCloseTaskRow {
  id: string;
  positionId: string;
  kind: string;
  failCount: number;
  lastError?: string;
  nextRetryAt: string;
  createdAt: string;
  lastAttemptAt?: string;
}

export async function fetchMonitorCloseTasks(): Promise<MonitorCloseTaskRow[]> {
  const res = await fetchWithTimeout(`${BACKEND_BASE}/monitor/close-tasks`, {}, 6_000);
  if (!res.ok) {
    throw new Error(`close-tasks failed (${res.status})`);
  }
  const body = (await res.json()) as { tasks?: MonitorCloseTaskRow[] };
  return Array.isArray(body.tasks) ? body.tasks : [];
}

export async function startMonitorFeed(): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/monitor/start`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `monitor start failed (${res.status})`);
  }
}

export async function stopMonitorFeed(): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/monitor/stop`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`monitor stop failed (${res.status})`);
  }
}

export async function armPosition(positionId: string): Promise<BackendPaperPosition> {
  const res = await fetch(`${BACKEND_BASE}/positions/${encodeURIComponent(positionId)}/arm`, {
    method: "POST",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `arm failed (${res.status})`);
  }
  return body as BackendPaperPosition;
}

export interface HomeTickQuote {
  tokenId: string;
  midpoint?: number;
  bestBid?: number;
  bestAsk?: number;
}

/** Parallel CLOB quotes for outcome tokens (works for open and stopped positions). */
export async function fetchHomeTicks(tokenIds: string[]): Promise<Record<string, HomeTickQuote>> {
  const ids = [...new Set(tokenIds.map((t) => t.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return {};
  }
  const res = await fetchWithTimeout(
    `${BACKEND_BASE}/api/home/ticks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenIds: ids }),
    },
    10_000,
  );
  const body = (await res.json().catch(() => ({}))) as {
    quotes?: Record<string, HomeTickQuote>;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || `home ticks failed (${res.status})`);
  }
  const raw = body.quotes ?? {};
  const out: Record<string, HomeTickQuote> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && typeof v === "object") {
      out[k] = { ...(v as object), tokenId: k } as HomeTickQuote;
    }
  }
  return out;
}

/** SQLite-backed closed positions (GET /api/history/closed). */
export interface ClosedPositionHistoryRow {
  positionId: string;
  marketId?: string;
  eventId?: string;
  conditionId?: string;
  tokenId: string;
  outcomeLabel?: string;
  shares: number;
  costUsdc: number;
  avgEntryPrice: number;
  highWaterMark: number;
  stopTrailPct: number;
  closeReason: string;
  orderId?: string;
  paper?: boolean;
  lastBid?: number;
  lastMid?: number;
  closedAt: string;
}

export async function fetchClosedTradeHistory(limit = 120): Promise<ClosedPositionHistoryRow[]> {
  const res = await fetchWithTimeout(
    `${BACKEND_BASE}/api/history/closed?limit=${limit}`,
    {},
    8_000,
  );
  const body = (await res.json().catch(() => ({}))) as {
    rows?: ClosedPositionHistoryRow[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || `history closed failed (${res.status})`);
  }
  return Array.isArray(body.rows) ? body.rows : [];
}

export async function disarmPosition(positionId: string): Promise<BackendPaperPosition> {
  const res = await fetch(`${BACKEND_BASE}/positions/${encodeURIComponent(positionId)}/disarm`, {
    method: "POST",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `disarm failed (${res.status})`);
  }
  return body as BackendPaperPosition;
}

export async function updatePosition(
  positionId: string,
  patch: { stopTrailPct?: number; monitoringActive?: boolean },
): Promise<BackendPaperPosition> {
  const res = await fetch(`${BACKEND_BASE}/positions/${encodeURIComponent(positionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `update position failed (${res.status})`);
  }
  return body as BackendPaperPosition;
}

export async function fetchPositions(paper?: boolean): Promise<BackendPaperPosition[]> {
  const qs = new URLSearchParams();
  if (paper === true) qs.set("paper", "true");
  if (paper === false) qs.set("paper", "false");
  const query = qs.toString();
  const res = await fetchWithTimeout(
    `${BACKEND_BASE}/positions${query ? `?${query}` : ""}`,
    {},
    6_000,
  );
  if (!res.ok) {
    throw new Error(`positions failed (${res.status})`);
  }
  return res.json() as Promise<BackendPaperPosition[]>;
}

/** Data API /positions vs local monitor store (GET /positions/reconcile). */
export interface ReconcileRow {
  tokenId: string;
  localId?: string;
  marketId?: string;
  localShares: number;
  chainShares?: number;
  drift: boolean;
  note?: string;
}

export interface ReconcileResponse {
  proxy: string;
  rows: ReconcileRow[];
}

export async function fetchReconcile(): Promise<ReconcileResponse> {
  const res = await fetchWithTimeout(`${BACKEND_BASE}/positions/reconcile`, {}, 12_000);
  if (!res.ok) {
    throw new Error(`reconcile failed (${res.status})`);
  }
  return res.json() as Promise<ReconcileResponse>;
}

// --- Backend trading accounts (JSON on server; LAN-only) ---

export interface BackendAccountView {
  id: string;
  label: string;
  eoaAddress: string;
  proxyWalletAddress?: string;
  isDefault: boolean;
  /** CLOB 现金（抵押） */
  usdcBalance: number;
  /** Data API 持仓价值合计 */
  portfolioValue: number;
  balanceNote: string;
  hasClobCredentials: boolean;
}

export interface AccountsListResponse {
  defaultId: string;
  accounts: BackendAccountView[];
}

export interface CreateBackendAccountRequest {
  label?: string;
  evmPrivateKey: string;
}

export async function fetchAccountsList(): Promise<AccountsListResponse> {
  const res = await fetch(`${BACKEND_BASE}/api/accounts`);
  if (!res.ok) {
    throw new Error(`accounts list failed (${res.status})`);
  }
  return res.json() as Promise<AccountsListResponse>;
}

/** Sync header / 资金池用的默认账户展示（失败时保留上次状态）。返回列表供下拉等使用。 */
export async function syncWalletFromBackend(): Promise<AccountsListResponse | null> {
  try {
    const data = await fetchAccountsList();
    const def = data.accounts.find((a) => a.isDefault) ?? data.accounts[0];
    if (def) {
      const raw = (def.proxyWalletAddress || def.eoaAddress || "").trim();
      const label = def.label?.trim() || null;
      useWalletStore.getState().setWallet({
        address: raw || null,
        accountId: def.id,
        accountLabel: label,
        usdcBalance: def.usdcBalance,
        portfolioValue: def.portfolioValue ?? 0,
        balanceNote: def.balanceNote?.trim() || null,
      });
    } else {
      useWalletStore.getState().disconnect();
    }
    return data;
  } catch {
    /* backend 不可达时不清空，避免闪烁 */
    return null;
  }
}

export async function createBackendAccount(
  req: CreateBackendAccountRequest,
): Promise<BackendAccountView> {
  const res = await fetch(`${BACKEND_BASE}/api/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `create account failed (${res.status})`);
  }
  return body as BackendAccountView;
}

export async function deleteBackendAccount(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/api/accounts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `delete failed (${res.status})`);
  }
}

export async function setDefaultBackendAccount(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/api/accounts/${encodeURIComponent(id)}/default`, {
    method: "POST",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `set default failed (${res.status})`);
  }
}

/** GET /api/runtime-status — backend chain sync, CLOB WS monitor, last price tick. */
export interface RuntimeStatus {
  monitorWsRunning: boolean;
  lastChainSyncAt: string | null;
  lastChainSyncError: string | null;
  lastDataApiUser: string | null;
  lastChainPositionsCount: number;
  openPositionsCount: number;
  lastPriceTickAt: string | null;
}

export async function fetchRuntimeStatus(): Promise<RuntimeStatus> {
  const res = await fetchWithTimeout(`${BACKEND_BASE}/api/runtime-status`, {}, 5_000);
  if (!res.ok) {
    throw new Error(`runtime-status failed (${res.status})`);
  }
  return (await res.json()) as RuntimeStatus;
}

/** Overwrite proxy with CREATE2-derived Polymarket Safe for this account (fixes Data API user address). */
export async function syncDerivedProxyAccount(id: string): Promise<BackendAccountView> {
  const res = await fetch(
    `${BACKEND_BASE}/api/accounts/${encodeURIComponent(id)}/sync-derived-proxy`,
    { method: "POST" },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error || `sync proxy failed (${res.status})`);
  }
  return body as BackendAccountView;
}
