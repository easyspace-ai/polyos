import { useEffect, useMemo, useRef, useState } from "react";
import { useMarketStore } from "@/lib/store";
import { fetchHomeTicks, wsBoardURL } from "@/lib/polymarket";
import type { Market } from "@/lib/types";

/**
 * Subscribes to backend `/ws/board` for CLOB best bid/ask/mid on all displayed outcome tokens.
 * Patches `useMarketStore` on each tick (~2s). Full `/api/home/markets` refresh still updates depth/volume.
 */
export function useBoardPriceStream(markets: Market[]) {
  const patchMarket = useMarketStore((s) => s.patchMarket);
  const marketsRef = useRef(markets);
  marketsRef.current = markets;

  const tokenKey = useMemo(() => {
    const ids = new Set<string>();
    for (const m of markets) {
      const t = m.yesTokenId?.trim();
      if (t) ids.add(t);
    }
    return [...ids].sort().join(",");
  }, [markets]);

  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!tokenKey) {
      setConnected(false);
      return;
    }
    const tokenIds = tokenKey.split(",");

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let lastMessageAt = Date.now();
    let restBackfillBusy = false;
    let reconnectDelay = 3_000;

    const applyTicks = (
      quotes: Record<string, { midpoint?: number; bestBid?: number; bestAsk?: number }>,
    ) => {
      const list = marketsRef.current;
      for (const m of list) {
        const tid = m.yesTokenId?.trim();
        if (!tid) continue;
        const q = quotes[tid];
        if (!q) continue;
        const mid = Number(q.midpoint) || 0;
        let bestBid = Number(q.bestBid) || 0;
        let bestAsk = Number(q.bestAsk) || 0;
        if (mid > 0 && bestBid <= 0) bestBid = Math.max(0, mid - 0.005);
        if (mid > 0 && bestAsk <= 0) bestAsk = Math.min(1, mid + 0.005);
        const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : m.spread;
        patchMarket(m.id, {
          midPrice: mid > 0 ? mid : m.midPrice,
          bestBid: bestBid > 0 ? bestBid : m.bestBid,
          bestAsk: bestAsk > 0 ? bestAsk : m.bestAsk,
          spread,
        });
      }
    };

    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(wsBoardURL());
      } catch {
        setConnected(false);
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.8, 30_000);
        return;
      }

      ws.onopen = () => {
        try {
          ws?.send(JSON.stringify({ tokenIds }));
          setConnected(true);
          lastMessageAt = Date.now();
          reconnectDelay = 3_000;
        } catch {
          setConnected(false);
        }
      };

      ws.onmessage = (ev) => {
        lastMessageAt = Date.now();
        try {
          const data = JSON.parse(String(ev.data)) as {
            type?: string;
            quotes?: Record<string, { midpoint?: number; bestBid?: number; bestAsk?: number }>;
          };
          if (data.type === "ticks" && data.quotes) {
            applyTicks(data.quotes);
          }
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => setConnected(false);

      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 1.8, 30_000);
        }
      };
    };

    const startStaleWatch = () => {
      if (staleTimer) {
        clearInterval(staleTimer);
      }
      staleTimer = setInterval(() => {
        if (cancelled || restBackfillBusy) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastMessageAt < 30_000) return;
        restBackfillBusy = true;
        void (async () => {
          try {
            const quotes = await fetchHomeTicks(tokenIds);
            applyTicks(quotes);
            lastMessageAt = Date.now();
          } catch {
            /* keep ws path as primary; retry on next interval */
          } finally {
            restBackfillBusy = false;
          }
        })();
      }, 10_000);
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        ws?.close();
        ws = null;
        setConnected(false);
        return;
      }
      if (document.visibilityState === "visible" && (!ws || ws.readyState !== WebSocket.OPEN)) {
        connect();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    connect();
    startStaleWatch();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleTimer) clearInterval(staleTimer);
      ws?.close();
      setConnected(false);
    };
  }, [tokenKey, patchMarket]);

  return { connected };
}
