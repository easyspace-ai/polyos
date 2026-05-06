import { BACKEND_BASE } from "./polymarket";
import type { BackendPaperPosition } from "./polymarket";
import type { GlobalParams } from "./types";
import { normalizeGlobalParamsFromServer } from "./defaults";

async function errBody(res: Response): Promise<string> {
  const t = await res.text();
  try {
    const j = JSON.parse(t) as { error?: string; errorMsg?: string; message?: string };
    const parts = [j.error, j.errorMsg, j.message].filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (parts.length) return parts.join(" — ");
    return t;
  } catch {
    return t || res.statusText;
  }
}

export interface PlaceOrderResult {
  orderID?: string;
  id?: string;
  status?: string;
  asset_id?: string;
  price?: string;
  size_matched?: string;
  original_size?: string;
  outcome?: string;
  [k: string]: unknown;
}

export async function getOrder(orderId: string): Promise<PlaceOrderResult> {
  const res = await fetch(`${BACKEND_BASE}/orders/${encodeURIComponent(orderId)}`);
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return (await res.json()) as PlaceOrderResult;
}

/** CLOB market BUY for USDC notional (mid/FOK path via backend). */
export async function placeMarketBuy(params: {
  tokenId: string;
  amountUsdc: number;
  idempotencyKey?: string;
  dryRun?: boolean;
}): Promise<PlaceOrderResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (params.idempotencyKey) {
    headers["Idempotency-Key"] = params.idempotencyKey;
  }
  const res = await fetch(`${BACKEND_BASE}/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tokenId: params.tokenId,
      side: "BUY",
      amountUsdc: params.amountUsdc,
      // CLOB: 市价单必须为 FAK/FOK；与后端默认一致，此处显式写出便于排查
      orderType: "FAK",
      dryRun: params.dryRun ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return (await res.json()) as PlaceOrderResult;
}

/** PATCH global risk config (fractions 0–1). */
export async function patchRiskConfig(body: {
  defaultStopTrailPct?: number;
  minTickDebounceMs?: number;
}): Promise<{
  defaultStopTrailPct: number;
  minTickDebounceMs: number;
}> {
  const res = await fetch(`${BACKEND_BASE}/risk/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return (await res.json()) as Promise<{
    defaultStopTrailPct: number;
    minTickDebounceMs: number;
  }>;
}

/** Mark position manual_closed on server after selling. */
export async function closeBackendPosition(positionId: string): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/positions/${encodeURIComponent(positionId)}/close`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
}

/** Register position for monitor / risk (fraction stopTrailPct e.g. 0.15 for 15%). */
export async function registerBackendPosition(body: {
  id?: string;
  marketId: string;
  conditionId?: string;
  eventId?: string;
  tokenId: string;
  shares: number;
  avgEntryPrice: number;
  costUsdc: number;
  stopTrailPct: number;
  outcomeLabel?: string;
  paper?: boolean;
}): Promise<BackendPaperPosition> {
  const res = await fetch(`${BACKEND_BASE}/positions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: body.id,
      marketId: body.marketId,
      conditionId: body.conditionId,
      eventId: body.eventId,
      tokenId: body.tokenId,
      shares: body.shares,
      avgEntryPrice: body.avgEntryPrice,
      costUsdc: body.costUsdc,
      stopTrailPct: body.stopTrailPct,
      outcomeLabel: body.outcomeLabel?.trim(),
      paper: body.paper ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return (await res.json()) as BackendPaperPosition;
}

/** Public CLOB book summary for sell preflight (min order size, ticks). */
export async function fetchOrderBookSummary(tokenId: string): Promise<{
  tokenId: string;
  minOrderSize: number;
  tickSize: number;
  bestBid: number;
  bestAsk: number;
  negRisk: boolean;
}> {
  const qs = new URLSearchParams({ token_id: tokenId.trim() });
  const res = await fetch(`${BACKEND_BASE}/trading/order-book?${qs.toString()}`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `order-book failed (${res.status})`);
  }
  return {
    tokenId: String(body.tokenId ?? tokenId),
    minOrderSize: Number(body.minOrderSize) || 0,
    tickSize: Number(body.tickSize) || 0.01,
    bestBid: Number(body.bestBid) || 0,
    bestAsk: Number(body.bestAsk) || 0,
    negRisk: Boolean(body.negRisk),
  };
}

export async function marketSell(params: {
  tokenId: string;
  shares: number;
  dryRun?: boolean;
}): Promise<unknown> {
  const res = await fetch(`${BACKEND_BASE}/trading/market-sell`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tokenId: params.tokenId,
      shares: params.shares,
      dryRun: params.dryRun ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return res.json();
}

/** Cancel all orders + market-sell. Prefer passing `sells` from UI so local positions match chain. */
/** Authenticated CLOB open + historical orders (see GET /data/orders). */
export async function fetchCLOBOrders(limit = 50): Promise<{
  data: PlaceOrderResult[];
  next_cursor?: string;
}> {
  const res = await fetch(`${BACKEND_BASE}/trading/orders?limit=${limit}`);
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return (await res.json()) as {
    data: PlaceOrderResult[];
    next_cursor?: string;
  };
}

/** Authenticated CLOB trades history. */
export async function fetchCLOBTrades(limit = 50): Promise<{
  data: CLOBTradeRow[];
  next_cursor?: string;
}> {
  const res = await fetch(`${BACKEND_BASE}/trading/trades?limit=${limit}`);
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return (await res.json()) as {
    data: CLOBTradeRow[];
    next_cursor?: string;
  };
}

/** Gamma metadata for a CLOB outcome token (used when the market is off the home feed). */
export type ClobTokenMarketMeta = {
  question: string;
  outcome?: string;
  eventSlug?: string;
  polymarketUrl?: string;
  eventTitle?: string;
};

export async function fetchMarketMetaByClobTokens(
  tokenIds: string[],
): Promise<Record<string, ClobTokenMarketMeta>> {
  const uniq = [...new Set(tokenIds.map((s) => s.trim()).filter(Boolean))];
  if (uniq.length === 0) {
    return {};
  }
  const qs = new URLSearchParams();
  for (const id of uniq.slice(0, 80)) {
    qs.append("token", id);
  }
  const res = await fetch(`${BACKEND_BASE}/api/markets/resolve-by-clob-tokens?${qs.toString()}`);
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  const body = (await res.json()) as { markets?: Record<string, ClobTokenMarketMeta> };
  return body.markets ?? {};
}

/** CLOB GET /data/trades row (Polymarket official shape; extra keys tolerated). */
export interface CLOBTradeRow {
  id?: string;
  price?: string;
  size?: string;
  side?: string;
  /** Unix seconds (官方截图常为 10 位整数) */
  timestamp?: number;
  asset_id?: string;
  market?: string;
  status?: string;
  match_time?: string;
  transaction_hash?: string;
  taker_order_id?: string;
  maker_order_id?: string;
}

export async function closeAllTrading(
  sells: { tokenId: string; shares: number }[],
): Promise<unknown> {
  const res = await fetch(`${BACKEND_BASE}/trading/close-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sells.length ? { sells } : {}),
  });
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return res.json();
}

/** GET persisted UI global params (`data/global-params.json` on backend). */
export async function fetchGlobalParams(timeoutMs = 12_000): Promise<GlobalParams> {
  const signal =
    typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  const res = await fetch(`${BACKEND_BASE}/api/settings/global-params`, { signal });
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
  return normalizeGlobalParamsFromServer(await res.json());
}

/** PUT replace global params (same shape as `GlobalParams`). */
export async function saveGlobalParams(params: GlobalParams): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/api/settings/global-params`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(await errBody(res));
  }
}
