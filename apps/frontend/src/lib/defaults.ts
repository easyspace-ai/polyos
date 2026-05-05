import type { GlobalParams, TierConfig } from "./types";

export const DEFAULT_PARAMS: GlobalParams = {
  dailyBudgetPct: 30,
  externalDefaultStopLossPct: 20,
  homeMarketsTimeoutSec: 25,
  homeMarketsCacheTtlSec: 180,
  maxSpread: 0.05,
  minDepthMultiplier: 3,
  leagues: ["NBA", "NHL"],
  tiers: [
    { id: "20-30", label: "20-30¢", min: 0.2, max: 0.3, allocPct: 17, defaultStopLoss: 20 },
    { id: "30-40", label: "30-40¢", min: 0.3, max: 0.4, allocPct: 17, defaultStopLoss: 20 },
    { id: "40-50", label: "40-50¢", min: 0.4, max: 0.5, allocPct: 17, defaultStopLoss: 20 },
    { id: "50-60", label: "50-60¢", min: 0.5, max: 0.6, allocPct: 17, defaultStopLoss: 20 },
    { id: "60-70", label: "60-70¢", min: 0.6, max: 0.7, allocPct: 16, defaultStopLoss: 20 },
    { id: "70-80", label: "70-80¢", min: 0.7, max: 0.8, allocPct: 16, defaultStopLoss: 20 },
  ],
};

export const STORAGE_KEY = "polymkt-bball-params-v1";

const num = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/** 合并 GET 返回值与默认项；兼容旧字段 `defaultStopLossPct` / `refreshIntervalSec`。 */
export function normalizeGlobalParamsFromServer(data: unknown): GlobalParams {
  if (!data || typeof data !== "object") {
    return { ...DEFAULT_PARAMS };
  }
  const r = data as Record<string, unknown>;
  const tiersRaw = r.tiers;
  const tiers: TierConfig[] = Array.isArray(tiersRaw)
    ? (tiersRaw as TierConfig[]).filter((t) => t && typeof t.id === "string")
    : DEFAULT_PARAMS.tiers;
  const leaguesRaw = r.leagues;
  const leagues = Array.isArray(leaguesRaw) ? leaguesRaw : DEFAULT_PARAMS.leagues;
  const leaguesClean = leagues.filter((x): x is string => typeof x === "string");
  return {
    dailyBudgetPct: num(r.dailyBudgetPct, DEFAULT_PARAMS.dailyBudgetPct),
    externalDefaultStopLossPct: num(
      r.externalDefaultStopLossPct ?? r.defaultStopLossPct,
      DEFAULT_PARAMS.externalDefaultStopLossPct,
    ),
    homeMarketsTimeoutSec: Math.round(
      Math.min(
        120,
        Math.max(5, num(r.homeMarketsTimeoutSec, DEFAULT_PARAMS.homeMarketsTimeoutSec)),
      ),
    ),
    homeMarketsCacheTtlSec: Math.round(
      Math.min(
        7200,
        Math.max(
          30,
          num(r.homeMarketsCacheTtlSec ?? r["home_markets_cache_ttl_sec"], DEFAULT_PARAMS.homeMarketsCacheTtlSec),
        ),
      ),
    ),
    maxSpread: num(r.maxSpread, DEFAULT_PARAMS.maxSpread),
    minDepthMultiplier: num(r.minDepthMultiplier, DEFAULT_PARAMS.minDepthMultiplier),
    tiers: tiers.length >= 1 ? tiers : DEFAULT_PARAMS.tiers,
    leagues: leaguesClean.length > 0 ? leaguesClean : DEFAULT_PARAMS.leagues,
  };
}
