import type { GlobalParams, Market, PriceTier, TierConfig } from "./types";

export function getTierForPrice(price: number, tiers: TierConfig[]): PriceTier | null {
  const t = tiers.find((x) => price >= x.min && price <= x.max);
  return t ? t.id : null;
}

export function getStopLossPctForPrice(price: number, params: GlobalParams): number {
  const tierID = getTierForPrice(price, params.tiers);
  const tier = tierID ? params.tiers.find((x) => x.id === tierID) : undefined;
  return tier?.defaultStopLoss ?? params.externalDefaultStopLossPct;
}

/**
 * 资金分配公式：
 *   tierBudget = totalAsset * dailyBudgetPct% * tier.allocPct%
 *   suggested  = tierBudget / 该区间内通过校验的赛事数
 */
export function computeSuggestedAmounts(
  markets: Market[],
  params: GlobalParams,
  totalAssetUSDC: number,
): Market[] {
  const dailyPool = totalAssetUSDC * (params.dailyBudgetPct / 100);

  const validByTier: Record<string, Market[]> = {};
  for (const t of params.tiers) validByTier[t.id] = [];
  for (const m of markets) {
    if (!m.tier) continue;
    // 仅对「>50¢」一侧参与资金池分配与自动建议金额（胜负盘热门侧）
    if (!(m.midPrice > 0.5)) continue;
    if (m.spread > params.maxSpread) continue;
    if (!validByTier[m.tier]) continue;
    validByTier[m.tier].push(m);
  }

  return markets.map((m) => {
    if (!m.tier) return { ...m, suggestedAmount: 0 };
    if (!(m.midPrice > 0.5)) return { ...m, suggestedAmount: 0 };
    const tier = params.tiers.find((t) => t.id === m.tier)!;
    const tierBudget = dailyPool * (tier.allocPct / 100);
    const cohort = validByTier[m.tier];
    const per = cohort.length > 0 ? tierBudget / cohort.length : 0;
    // 建议金额为整数 USDC（不支持小数）
    return { ...m, suggestedAmount: Math.round(per) };
  });
}

export function passesDepthCheck(m: Market, params: GlobalParams): boolean {
  const need = (m.customAmount ?? m.suggestedAmount) * params.minDepthMultiplier;
  return m.askDepth >= need;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats a dollar amount for display: thousands separators + exactly 2 decimal places (e.g. $9,475,066.00).
 * Accepts numbers or numeric strings from APIs; non-finite values show as $0.00.
 */
export function formatUSD(n: number | string | null | undefined): string {
  const x =
    typeof n === "string"
      ? Number(n.trim().replace(/,/g, ""))
      : typeof n === "number"
        ? n
        : Number(n);
  if (!Number.isFinite(x)) {
    return usdFormatter.format(0);
  }
  return usdFormatter.format(x);
}

function parseUsdcNumber(n: number | string | null | undefined): number {
  const x =
    typeof n === "string"
      ? Number(n.trim().replace(/,/g, ""))
      : typeof n === "number"
        ? n
        : Number(n);
  return Number.isFinite(x) ? x : 0;
}

export function formatPct(n: number, digits = 2): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

/** Polymarket outcome price in [0,1] → 美分文案，如 52¢、90.5¢ */
export function formatProbPriceCents(n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return "—";
  }
  const cents = n * 100;
  if (Math.abs(cents - Math.round(cents)) < 1e-6) {
    return `${Math.round(cents)}¢`;
  }
  return `${cents.toFixed(1)}¢`;
}

/** 买卖价差宽度（与价格同量级）→ 美分，如 1.00¢ */
export function formatSpreadWidthCents(spread: number): string {
  if (!Number.isFinite(spread) || spread <= 0) {
    return "—";
  }
  return `${(spread * 100).toFixed(2)}¢`;
}

/** @deprecated 语义同 formatProbPriceCents（历史调用处较多，保留别名） */
export function formatPrice(n: number): string {
  return formatProbPriceCents(n);
}

/** Polymarket NBA copy 习惯用美东开赛；与规则页「7:00PM ET」一致 */
export function formatNBATipOffET(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return `${s} ET`;
}
