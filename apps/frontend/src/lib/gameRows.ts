import type { Market, MarketsSortDir, MarketsSortKey } from "./types";

export type GameRow = {
  key: string;
  legs: Market[];
  favorite: Market;
  underdog: Market;
};

export function eventGroupKey(m: Market): string {
  if (m.eventId) return m.eventId;
  const i = m.id.lastIndexOf(":");
  if (i > 0) return m.id.slice(0, i);
  return m.id;
}

/** 「Knicks vs Hawks · Hawks」→「Hawks」 */
export function outcomeShortLabel(m: Market): string {
  return outcomeShortLabelFromQuestion(m.question);
}

export function outcomeShortLabelFromQuestion(question: string): string {
  const q = question;
  const idx = q.indexOf(" · ");
  if (idx >= 0) return q.slice(idx + 3).trim();
  return q.trim();
}

/** 对阵标题（去掉 · 队名） */
export function baseMatchTitleString(question: string): string {
  const q = question;
  const idx = q.indexOf(" · ");
  if (idx >= 0) return q.slice(0, idx).trim();
  return q.trim();
}

/** 对阵标题（去掉 · 队名） */
export function baseMatchTitle(m: Market): string {
  return baseMatchTitleString(m.question);
}

export function groupMarketsForDisplay(markets: Market[]): GameRow[] {
  const by = new Map<string, Market[]>();
  for (const m of markets) {
    const k = eventGroupKey(m);
    const arr = by.get(k) ?? [];
    arr.push(m);
    by.set(k, arr);
  }
  const out: GameRow[] = [];
  for (const [key, legs] of by) {
    if (legs.length === 0) continue;
    const sorted = [...legs].sort((a, b) => b.midPrice - a.midPrice || b.bestAsk - a.bestAsk);
    const favorite = sorted[0];
    const underdog = sorted.length > 1 ? sorted[sorted.length - 1] : sorted[0];
    out.push({ key, legs: sorted, favorite, underdog });
  }
  return out;
}

export function orderLegsForDisplay(legs: Market[]): Market[] {
  return [...legs].sort((a, b) => b.midPrice - a.midPrice || b.bestAsk - a.bestAsk);
}

export function sortGameRows(list: GameRow[], key: MarketsSortKey, dir: MarketsSortDir): GameRow[] {
  const mul = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const fa = a.favorite;
    const fb = b.favorite;
    let c = 0;
    switch (key) {
      case "start":
        c = new Date(fa.startTime).getTime() - new Date(fb.startTime).getTime();
        break;
      case "open":
        c = fa.openPrice - fb.openPrice;
        break;
      case "depth":
        c = fa.askDepth - fb.askDepth;
        break;
      case "volume":
        c = (fa.volume24h ?? 0) - (fb.volume24h ?? 0);
        break;
    }
    if (c !== 0) return mul * c;
    return baseMatchTitle(fa).localeCompare(baseMatchTitle(fb), "zh-Hans");
  });
}
