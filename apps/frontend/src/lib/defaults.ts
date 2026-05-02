import type { GlobalParams, TierConfig } from "./types";

export const DEFAULT_PARAMS: GlobalParams = {
  dailyBudgetPct: 30,
  externalDefaultStopLossPct: 20,
  maxSpread: 0.05,
  minDepthMultiplier: 3,
  leagues: ["NBA", "NCAAB", "NHL"],
  tiers: [
    { id: "A", label: "高赔率区间", min: 0.05, max: 0.25, allocPct: 50, defaultStopLoss: 30 },
    { id: "B", label: "中赔率区间", min: 0.25, max: 0.55, allocPct: 30, defaultStopLoss: 20 },
    { id: "C", label: "低赔率区间", min: 0.55, max: 0.85, allocPct: 20, defaultStopLoss: 15 },
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
  const leagues = (Array.isArray(leaguesRaw) ? leaguesRaw : DEFAULT_PARAMS.leagues) as (
    | "NBA"
    | "NCAAB"
    | "NHL"
  )[];
  const okLeague = (x: unknown): x is "NBA" | "NCAAB" | "NHL" =>
    x === "NBA" || x === "NCAAB" || x === "NHL";
  const leaguesClean = leagues.filter(okLeague);
  return {
    dailyBudgetPct: num(r.dailyBudgetPct, DEFAULT_PARAMS.dailyBudgetPct),
    externalDefaultStopLossPct: num(
      r.externalDefaultStopLossPct ?? r.defaultStopLossPct,
      DEFAULT_PARAMS.externalDefaultStopLossPct,
    ),
    maxSpread: num(r.maxSpread, DEFAULT_PARAMS.maxSpread),
    minDepthMultiplier: num(r.minDepthMultiplier, DEFAULT_PARAMS.minDepthMultiplier),
    tiers: tiers.length >= 1 ? tiers : DEFAULT_PARAMS.tiers,
    leagues: leaguesClean.length > 0 ? leaguesClean : DEFAULT_PARAMS.leagues,
  };
}
