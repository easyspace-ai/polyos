import { useEffect, useRef, useState } from "react";

/** Polymarket Sports Channel public WS (see docs/api-reference/wss/sports.md). */
export const SPORTS_WS_URL = "wss://sports-api.polymarket.com/ws";

export interface SportsLiveUpdate {
  slug: string;
  live?: boolean;
  ended?: boolean;
  score?: string;
  period?: string;
  elapsed?: string;
  last_update?: string;
  finished_timestamp?: string;
  turn?: string;
}

/** Canonical key for Sports WS rows and Gamma `eventSlug` (case-insensitive). */
export function normalizeSportsSlug(s: string | undefined): string {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

/** Extract `/event/{slug}` from a Polymarket URL when `eventSlug` is missing on the row. */
export function eventSlugFromPolymarketUrl(url: string | undefined): string {
  if (!url || typeof url !== "string") return "";
  const path = url.trim().split("?")[0] ?? "";
  const m = /\/event\/([^/?#]+)/i.exec(path);
  if (!m?.[1]) return "";
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

/** Slug to subscribe / lookup: API field first, else URL path. */
export function sportsSlugForWsWatch(meta: { eventSlug?: string; polymarketUrl?: string }): string {
  const fromField = normalizeSportsSlug(meta.eventSlug);
  if (fromField) return fromField;
  return normalizeSportsSlug(eventSlugFromPolymarketUrl(meta.polymarketUrl));
}

/** Resolve slug for a `marketId` when syncing positions with Sports WS (slug map + Polymarket URL fallback). */
export function sportsSlugForPositionRow(
  marketId: string,
  slugByMarketId: Map<string, string>,
  urlByMarketId: Map<string, string>,
): string {
  const raw = (slugByMarketId.get(marketId) || "").trim();
  if (raw) return normalizeSportsSlug(raw);
  return normalizeSportsSlug(eventSlugFromPolymarketUrl(urlByMarketId.get(marketId)));
}

/** 持仓行：首页 `markets` 可能没有该场 → 用 CLOB 解析出的 `eventSlug` / URL 再取 slug，才能订阅赛果 WS 并在结束后自动移除。 */
export function sportsSlugForMonitorRow(
  row: { marketId: string; tokenId?: string | null },
  slugByMarketId: Map<string, string>,
  urlByMarketId: Map<string, string>,
  metaByToken: Record<string, { eventSlug?: string; polymarketUrl?: string }>,
): string {
  const fromBoard = sportsSlugForPositionRow(row.marketId, slugByMarketId, urlByMarketId);
  if (fromBoard) return fromBoard;
  const tid = String(row.tokenId ?? "").trim();
  if (!tid) return "";
  const meta = metaByToken[tid];
  if (!meta) return "";
  return sportsSlugForWsWatch({
    eventSlug: meta.eventSlug,
    polymarketUrl: meta.polymarketUrl,
  });
}

function liveFlagTruthy(u: SportsLiveUpdate): boolean {
  const v = u.live as unknown;
  if (v === true) return true;
  if (typeof v === "string" && ["true", "1", "yes"].includes(v.trim().toLowerCase())) {
    return true;
  }
  return false;
}

/** Period strings that imply the clock is running (feeds often omit boolean `live`). */
function periodImpliesInPlay(period: string | undefined): boolean {
  const p = String(period ?? "")
    .trim()
    .toUpperCase();
  if (!p) return false;
  if (["FT", "FINAL", "FIN", "POST", "CAN", "AB", "INT"].includes(p)) return false;
  if (/^Q[1-4]$/.test(p) || p === "OT" || p === "HT") return true;
  if (/^P[1-3]$/.test(p) || p === "PEN" || p === "SO") return true;
  if (p === "1H" || p === "2H") return true;
  if (/^(TOP|BOT)\s+/i.test(p)) return true;
  return false;
}

/** True when the match looks in progress (not ended). */
export function isSportsEventInPlay(u: SportsLiveUpdate | undefined): u is SportsLiveUpdate {
  if (!u) return false;
  if (u.ended === true) return false;
  if (liveFlagTruthy(u)) return true;
  return periodImpliesInPlay(u.period);
}

/**
 * Subscribes to the public sports results stream and keeps the latest row per slug.
 * Only applies updates whose `slug` is in `watchedSlugs` to limit noise.
 * Responds to server `ping` with `pong` per spec.
 */
export function useSportsLiveUpdates(watchedSlugs: string[]) {
  const [bySlug, setBySlug] = useState<Record<string, SportsLiveUpdate>>({});
  const watchRef = useRef<Set<string>>(new Set());
  const normalized = watchedSlugs.map((s) => normalizeSportsSlug(s)).filter(Boolean);
  watchRef.current = new Set(normalized);
  const watchKey = normalized.length ? [...normalized].sort().join("\n") : "";

  useEffect(() => {
    if (!watchKey) {
      return;
    }

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(SPORTS_WS_URL);
      ws.onmessage = (ev) => {
        if (ev.data === "ping") {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send("pong");
          }
          return;
        }
        try {
          const j = JSON.parse(String(ev.data)) as SportsLiveUpdate;
          const slugNorm = normalizeSportsSlug(j.slug);
          if (!slugNorm) {
            return;
          }
          const w = watchRef.current;
          if (w.size > 0 && !w.has(slugNorm)) {
            return;
          }
          setBySlug((prev) => ({ ...prev, [slugNorm]: { ...prev[slugNorm], ...j, slug: j.slug } }));
        } catch {
          /* non-json */
        }
      };
    } catch {
      /* ignore */
    }

    return () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [watchKey]);

  return bySlug;
}
