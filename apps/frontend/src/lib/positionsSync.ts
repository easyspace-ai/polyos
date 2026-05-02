import { getTierForPrice } from "./calc";
import type { BackendPaperPosition } from "./polymarket";
import type { GlobalParams, Market, Position, PositionStatus } from "./types";

export function mapBackendStateToStatus(state: string): PositionStatus {
  switch (state) {
    case "open":
      return "bought";
    case "stopped_out":
      return "stopped";
    case "manual_closed":
    case "global_flat":
      return "sold";
    default:
      return "bought";
  }
}

/** Map backend position row to UI `Position` (merge `markets` for title/tier when available). */
export function backendRowToPosition(
  p: BackendPaperPosition,
  markets: Market[],
  params: GlobalParams,
): Position {
  const m = markets.find((x) => x.id === p.marketId);
  const stopPct = p.stopTrailPct > 1 ? p.stopTrailPct : p.stopTrailPct * 100;
  const mid = m && m.midPrice > 0 ? m.midPrice : p.avgEntryPrice;
  const status = mapBackendStateToStatus(p.state);
  const tier = m?.tier ?? getTierForPrice(p.avgEntryPrice, params.tiers) ?? "C";
  const pnl = (mid - p.avgEntryPrice) * p.shares;
  const pnlPct = p.avgEntryPrice > 0 ? ((mid - p.avgEntryPrice) / p.avgEntryPrice) * 100 : 0;
  return {
    paper: p.paper,
    backendPositionId: p.id,
    outcomeLabel: p.outcomeLabel?.trim() || undefined,
    marketId: p.marketId,
    tokenId: p.tokenId,
    question: m?.question ?? `Market ${p.marketId}`,
    league: m?.league ?? "NBA",
    tier,
    side: "YES",
    entryPrice: p.avgEntryPrice,
    currentPrice: mid,
    highWaterMark: p.highWaterMark > 0 ? p.highWaterMark : p.avgEntryPrice,
    amountUSDC: p.costUsdc,
    shares: p.shares,
    stopLossPct: stopPct,
    status,
    pnl,
    pnlPct,
    createdAt: Date.now(),
  };
}
