/** Parse numeric fields from CLOB JSON (strings or numbers). */
function num(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

export type ClobOrderLike = Record<string, unknown>;

export function orderIdFromResponse(order: ClobOrderLike): string {
  const id = (order.orderID as string) || (order.orderId as string) || (order.id as string) || "";
  return String(id).trim();
}

/**
 * Derive average fill price, shares and USDC cost from CLOB order response.
 *
 * Polymarket「均价」= 交易金额 / 份额（VWAP），与 UI 一致；不要用 `price` 当均价——
 * 市价买单里 `price` 常为扫盘上限（worst tick），会低于 VWAP（例如 94¢ vs 96¢）。
 */
export function parseMarketBuyFill(
  order: ClobOrderLike,
  requestedUsdc: number,
  fallbackPrice: number,
): { avgPrice: number; shares: number; costUsdc: number } {
  const sizeMatched = num(order.size_matched ?? order.sizeMatched);
  const ceilingPx = num(order.price);
  const ceiling = ceilingPx > 0 && ceilingPx <= 1 ? ceilingPx : 0;

  let shares =
    sizeMatched > 0
      ? sizeMatched
      : fallbackPrice > 0 && requestedUsdc > 0
        ? requestedUsdc / fallbackPrice
        : 0;

  let costUsdc = 0;
  if (requestedUsdc > 0) {
    if (shares > 0 && ceiling > 0) {
      costUsdc = Math.min(requestedUsdc, shares * ceiling);
    } else if (shares > 0) {
      costUsdc = requestedUsdc;
    } else {
      costUsdc = requestedUsdc;
    }
  } else if (shares > 0 && ceiling > 0) {
    costUsdc = shares * ceiling;
  }

  let avgPrice =
    shares > 0 && costUsdc > 0 ? costUsdc / shares : ceiling > 0 ? ceiling : fallbackPrice;

  if (!Number.isFinite(avgPrice) || avgPrice <= 0) {
    avgPrice = fallbackPrice;
  }
  if (avgPrice > 1) {
    avgPrice = 1;
  }

  if (shares <= 0 && avgPrice > 0 && costUsdc > 0) {
    shares = costUsdc / avgPrice;
  }
  if (costUsdc <= 0 && shares > 0 && avgPrice > 0) {
    costUsdc = shares * avgPrice;
  }

  return { avgPrice, shares, costUsdc };
}
