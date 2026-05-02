import type { Market } from "./types";
import type { CLOBTradeRow } from "./tradingApi";

/** CLOB `timestamp` is Unix seconds; guard ms if ever passed. */
export function tradeTimestampMs(t: CLOBTradeRow): number | null {
  const raw = t.timestamp;
  if (raw == null || Number.isNaN(Number(raw))) {
    return null;
  }
  const n = Number(raw);
  return n > 1e12 ? n : n * 1000;
}

/** zh-CN absolute time for table column (官方表格「时间」可读形式). */
export function formatTradeDateTime(t: CLOBTradeRow): string {
  const ms = tradeTimestampMs(t);
  if (ms == null) {
    return (t.match_time as string | undefined)?.trim() || "—";
  }
  return new Date(ms).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 相对时间，对齐官方「17秒 前」风格 */
export function relativeTimeZh(t: CLOBTradeRow): string {
  const ms = tradeTimestampMs(t);
  if (ms == null) {
    return "—";
  }
  let diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 0) {
    diffSec = 0;
  }
  if (diffSec < 60) {
    return `${diffSec}秒 前`;
  }
  const m = Math.floor(diffSec / 60);
  if (m < 60) {
    return `${m}分 前`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `${h}时 前`;
  }
  const d = Math.floor(h / 24);
  if (d < 14) {
    return `${d}天 前`;
  }
  const w = Math.floor(d / 7);
  return `${w}周 前`;
}

export function parseNum(s: string | undefined): number {
  if (s == null || s === "") {
    return 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** BUY 为支出（负），SELL 为收入（正），与 Polymarket 价值列一致 */
export function tradeCashflowUsdc(t: CLOBTradeRow): number {
  const px = parseNum(t.price);
  const sz = parseNum(t.size);
  const notional = px * sz;
  const side = (t.side || "").toUpperCase();
  if (side === "BUY") {
    return -notional;
  }
  if (side === "SELL") {
    return notional;
  }
  return notional;
}

export function marketForTradeAsset(
  markets: Market[],
  assetId: string | undefined,
): Market | undefined {
  if (!assetId) {
    return undefined;
  }
  return markets.find((m) => m.yesTokenId === assetId || m.noTokenId === assetId);
}

/** CLOB `market` field is often a condition id (bytes32 hex). */
export function isBytes32ConditionHex(s: string | undefined): boolean {
  if (!s) {
    return false;
  }
  const v = s.trim();
  return /^0x[0-9a-f]{64}$/i.test(v);
}

export function shortDisplayId(s: string, head = 8, tail = 6): string {
  const t = s.trim();
  if (t.length <= head + tail + 1) {
    return t;
  }
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

/** Resolve home `markets` row for a CLOB trade (token id or condition id). */
export function marketForClobTrade(markets: Market[], t: CLOBTradeRow): Market | undefined {
  const asset = t.asset_id?.trim();
  if (asset) {
    const byTok = markets.find((m) => m.yesTokenId === asset || m.noTokenId === asset);
    if (byTok) {
      return byTok;
    }
  }
  const cond = t.market?.trim();
  if (cond && isBytes32ConditionHex(cond)) {
    const lc = cond.toLowerCase();
    return markets.find((m) => m.conditionId && m.conditionId.toLowerCase() === lc);
  }
  return undefined;
}

export function outcomeLabelForTrade(m: Market | undefined, assetId: string | undefined): string {
  if (!m || !assetId) {
    return "";
  }
  if (m.yesTokenId === assetId) {
    return "Yes";
  }
  if (m.noTokenId === assetId) {
    return "No";
  }
  return "";
}

export type TradeTimeRange = "all" | "24h" | "7d";

export function filterTradesByTimeRange(
  trades: CLOBTradeRow[],
  range: TradeTimeRange,
): CLOBTradeRow[] {
  if (range === "all") {
    return trades.slice();
  }
  const now = Date.now();
  const cut = range === "24h" ? now - 86400000 : now - 7 * 86400000;
  return trades.filter((t) => (tradeTimestampMs(t) ?? 0) >= cut);
}

export function filterTrades(
  trades: CLOBTradeRow[],
  query: string,
  side: "all" | "BUY" | "SELL",
): CLOBTradeRow[] {
  let rows = trades.slice();
  if (side !== "all") {
    rows = rows.filter((t) => (t.side || "").toUpperCase() === side);
  }
  const q = query.trim().toLowerCase();
  if (!q) {
    return rows;
  }
  return rows.filter((t) => {
    const id = (t.id || "").toLowerCase();
    const asset = (t.asset_id || "").toLowerCase();
    const mkt = (t.market || "").toLowerCase();
    const sd = (t.side || "").toLowerCase();
    return id.includes(q) || asset.includes(q) || mkt.includes(q) || sd.includes(q);
  });
}

export function sortTradesNewestFirst(trades: CLOBTradeRow[]): CLOBTradeRow[] {
  return [...trades].sort((a, b) => {
    const ma = tradeTimestampMs(a) ?? 0;
    const mb = tradeTimestampMs(b) ?? 0;
    return mb - ma;
  });
}

export function tradesToCSV(trades: CLOBTradeRow[]): string {
  const header = ["id", "side", "price", "size", "timestamp", "asset_id", "market"];
  const lines = [header.join(",")];
  for (const t of trades) {
    const row = [
      t.id ?? "",
      t.side ?? "",
      t.price ?? "",
      t.size ?? "",
      t.timestamp != null ? String(t.timestamp) : "",
      t.asset_id ?? "",
      (t.market ?? "").replaceAll(",", " "),
    ];
    lines.push(row.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(","));
  }
  return lines.join("\n");
}

export function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
