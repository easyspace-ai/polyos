import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatCard } from "./StatCard";
import { useMarketStore } from "@/lib/store";
import type { Market } from "@/lib/types";
import {
  formatNBATipOffET,
  formatPct,
  formatPrice,
  formatProbPriceCents,
  formatUSD,
} from "@/lib/calc";
import { baseMatchTitle, baseMatchTitleString } from "@/lib/gameRows";
import { cn } from "@/lib/utils";
import {
  disarmPosition,
  type ClosedPositionHistoryRow,
  fetchClosedTradeHistory,
  fetchHomeTicks,
  fetchMonitorSnapshot,
  fetchPositions,
  fetchReconcile,
  fetchMonitorCloseTasks,
  updatePosition,
  wsMonitorURL,
  type BackendPaperPosition,
  type HomeTickQuote,
  type MonitorCloseTaskRow,
  type MonitorSnapshot,
  type MonitorSnapshotPositionRow,
  type ReconcileResponse,
} from "@/lib/polymarket";
import { sportsSlugForMonitorRow, useSportsLiveUpdates } from "@/lib/sportsWs";
import { marketForClobTrade } from "@/lib/tradeHistory";
import {
  closeBackendPosition,
  fetchCLOBOrders,
  fetchCLOBTrades,
  fetchMarketMetaByClobTokens,
  marketSell,
  type CLOBTradeRow,
  type ClobTokenMarketMeta,
  type PlaceOrderResult,
} from "@/lib/tradingApi";
import { ClobTradeHistory } from "@/components/ClobTradeHistory";
import { LiveEventMark } from "@/components/LiveEventMark";

/** 与后端 risk.TrailingStopTriggerBid 一致：最高水位 × (1 − 止损比例)，无高水位时用均价。 */
function trailingStopTriggerPx(highWater: number, avgEntry: number, stopTrailPct: number): number {
  const hw = highWater > 0 ? highWater : avgEntry;
  const frac = stopTrailPct > 0 ? (stopTrailPct <= 1 ? stopTrailPct : stopTrailPct / 100) : 0;
  if (hw <= 0 || frac <= 0 || frac >= 1) return 0;
  return hw * (1 - frac);
}

function closeReasonZh(reason: string): string {
  switch (reason) {
    case "trail_stop":
      return "系统止损";
    case "chain_closed":
      return "链上已平仓";
    case "take_profit":
      return "历史·组合止盈";
    case "manual_close":
      return "手动平仓";
    case "manual_sell":
      return "手动卖出";
    default:
      return reason || "—";
  }
}

function rowTitle(
  row: MonitorSnapshotPositionRow,
  questionByMarketId: Map<string, string>,
): string {
  return questionByMarketId.get(row.marketId) ?? `Market ${row.marketId}`;
}

function marketURL(
  marketId: string,
  directURLByMarketId: Map<string, string>,
  slugByMarketId: Map<string, string>,
): string | null {
  const direct = (directURLByMarketId.get(marketId) || "").trim();
  if (direct) {
    return direct;
  }
  const slug = (slugByMarketId.get(marketId) || "").trim();
  if (!slug) {
    return null;
  }
  return `https://polymarket.com/event/${slug}`;
}

/** 持仓行展示：对齐「赛事列表」——标题链到 Polymarket、副标题、联赛·开赛时间。 */
function displayForMonitorRow(
  p: MonitorSnapshotPositionRow,
  meta: ClobTokenMarketMeta | undefined,
  markets: Market[],
  questionByMarketId: Map<string, string>,
  urlByMarketId: Map<string, string>,
  slugByMarketId: Map<string, string>,
): { headline: string; subtitle: string | null; metaLine: string | null; url: string | null } {
  const mk = markets.find(
    (m) =>
      (!!m.conditionId && m.conditionId === p.marketId) ||
      m.yesTokenId === p.tokenId ||
      m.noTokenId === p.tokenId ||
      m.id === p.marketId,
  );
  const headline = (() => {
    if (meta?.eventTitle?.trim()) {
      return baseMatchTitleString(meta.eventTitle.trim());
    }
    if (meta?.question?.trim()) {
      return baseMatchTitleString(meta.question.trim());
    }
    if (mk) {
      return baseMatchTitle(mk);
    }
    return rowTitle(p, questionByMarketId);
  })();
  const subtitle = (() => {
    if (meta?.question?.trim()) {
      const full = meta.question.trim();
      if (full !== headline) {
        return full;
      }
    }
    if (mk?.chineseSubtitle?.trim()) {
      return mk.chineseSubtitle.trim();
    }
    const ol = (p.outcomeLabel || "").trim();
    if (ol && meta?.outcome?.trim() && ol !== meta.outcome.trim()) {
      return `持仓 · ${ol}（${meta.outcome.trim()}）`;
    }
    if (meta?.outcome?.trim()) {
      return `方向 · ${meta.outcome.trim()}`;
    }
    if (ol) {
      return `方向 · ${ol}`;
    }
    return null;
  })();
  const metaLine = (() => {
    const parts: string[] = [];
    if (mk?.league) {
      parts.push(mk.league);
    }
    if (mk?.startTime) {
      parts.push(formatNBATipOffET(mk.startTime));
    }
    return parts.length ? parts.join(" · ") : null;
  })();
  const url =
    (meta?.polymarketUrl || "").trim() ||
    marketURL(p.marketId, urlByMarketId, slugByMarketId) ||
    (mk?.polymarketUrl || "").trim() ||
    null;
  return { headline, subtitle, metaLine, url };
}

function closeTaskKindZh(kind: string): string {
  switch (kind) {
    case "trail_stop":
      return "止损平仓";
    case "global_take_profit":
      return "遗留平仓任务";
    default:
      return kind;
  }
}

function midFromHomeQuote(q: HomeTickQuote | undefined): number {
  if (!q) return 0;
  const m = Number(q.midpoint) || 0;
  if (m > 0) return m;
  const bb = Number(q.bestBid) || 0;
  const ba = Number(q.bestAsk) || 0;
  if (bb > 0 && ba > 0) return (bb + ba) / 2;
  if (bb > 0) return bb;
  if (ba > 0) return ba;
  return 0;
}

/** When CLOB WS snapshot has no mid (feed idle / stopped-out row), use Gamma list mid for YES/NO. */
function midFromMarketBook(m: Market | undefined, tokenId: string): number {
  if (!m || !tokenId) return 0;
  const mid = Number(m.midPrice) || 0;
  if (mid <= 0) return 0;
  if (m.yesTokenId === tokenId) return mid;
  if (m.noTokenId === tokenId) return Math.max(0.001, Math.min(0.999, 1 - mid));
  return 0;
}

type SubTab = "positions" | "orders" | "history" | "reconcile";

/** 快照里 `costUsdc` 可能为 0（旧同步）；用 GET /positions 的持仓回填，均价才能显示。 */
function effectiveEntryPrice(
  row: MonitorSnapshotPositionRow,
  backend: BackendPaperPosition | undefined,
): number {
  if (row.shares > 0 && row.costUsdc > 0) {
    return row.costUsdc / row.shares;
  }
  if (backend) {
    if (backend.avgEntryPrice > 0) return backend.avgEntryPrice;
    if (backend.shares > 0 && backend.costUsdc > 0) {
      return backend.costUsdc / backend.shares;
    }
  }
  return 0;
}

/** 以 GET /positions 为准合并快照行情；避免仅依赖 /monitor/snapshot 或 WS 缺字段时列表为空。 */
function mergeDisplayRows(
  backend: BackendPaperPosition[],
  snap: MonitorSnapshot | null,
): MonitorSnapshotPositionRow[] {
  // 仅「持有中」进入实时列表；已止损等由后端状态保留，但不在此表展示
  const live = backend.filter((p) => !p.paper && p.state === "open");
  const snapRows = snap?.positions ?? [];
  return live.map((p) => {
    const sr = snapRows.find((r) => r.id === p.id);
    if (sr) {
      const costUsdc = sr.costUsdc > 0 ? sr.costUsdc : p.costUsdc;
      const shares = sr.shares > 0 ? sr.shares : p.shares;
      let mid = sr.mid ?? 0;
      if (mid <= 0 && p.avgEntryPrice > 0) {
        mid = p.avgEntryPrice;
      }
      const unrealizedMidUsdc =
        shares > 0 && mid > 0 ? shares * mid - costUsdc : (sr.unrealizedMidUsdc ?? 0);
      return { ...sr, costUsdc, shares, mid, unrealizedMidUsdc };
    }
    const mid = p.avgEntryPrice > 0 ? p.avgEntryPrice : 0;
    const unreal = p.shares > 0 && mid > 0 ? p.shares * mid - p.costUsdc : 0;
    return {
      id: p.id,
      marketId: p.marketId,
      eventId: p.eventId,
      tokenId: p.tokenId,
      shares: p.shares,
      costUsdc: p.costUsdc,
      stopTrailPct: p.stopTrailPct,
      outcomeLabel: p.outcomeLabel,
      state: p.state,
      monitoringActive: p.monitoringActive,
      highWaterMark: p.highWaterMark,
      bid: 0,
      ask: 0,
      mid,
      unrealizedMidUsdc: unreal,
      paper: !!p.paper,
    };
  });
}

export function MonitorTab() {
  const markets = useMarketStore((s) => s.markets);
  const questionByMarketId = useMemo(() => {
    const m = new Map<string, string>();
    for (const mk of markets) {
      m.set(mk.id, mk.question);
      if (mk.conditionId) {
        m.set(mk.conditionId, mk.question);
      }
    }
    return m;
  }, [markets]);

  const [subTab, setSubTab] = useState<SubTab>("positions");

  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [backendPositions, setBackendPositions] = useState<BackendPaperPosition[]>([]);
  const [positionsErr, setPositionsErr] = useState<string | null>(null);
  const [dataReady, setDataReady] = useState(false);

  const slugByMarketId = useMemo(() => {
    const m = new Map<string, string>();
    for (const mk of markets) {
      if (mk.eventSlug) {
        m.set(mk.id, mk.eventSlug);
        if (mk.conditionId) {
          m.set(mk.conditionId, mk.eventSlug);
        }
      }
    }
    return m;
  }, [markets]);

  const urlByMarketId = useMemo(() => {
    const m = new Map<string, string>();
    for (const mk of markets) {
      if (mk.polymarketUrl) {
        m.set(mk.id, mk.polymarketUrl);
        if (mk.conditionId) {
          m.set(mk.conditionId, mk.polymarketUrl);
        }
      }
    }
    return m;
  }, [markets]);

  const [positionMetaByToken, setPositionMetaByToken] = useState<
    Record<string, ClobTokenMarketMeta>
  >({});
  const positionMetaByTokenRef = useRef(positionMetaByToken);
  positionMetaByTokenRef.current = positionMetaByToken;
  /** Tokens Gamma 从未返回过 meta（或请求失败）：不再 tight-loop 重试；持仓关闭时从集合移除。 */
  const positionMetaAttemptedRef = useRef(new Set<string>());

  /** Gamma 元数据：用于持仓「盘口」列展示赛题与 polymarket.com 链接（`marketId` 常为 conditionId，与赛事列表 id 不一致）。 */
  useEffect(() => {
    const openTids = new Set(
      backendPositions
        .filter((p) => !p.paper && p.state === "open" && (p.tokenId || "").trim())
        .map((p) => p.tokenId.trim()),
    );
    for (const t of [...positionMetaAttemptedRef.current]) {
      if (!openTids.has(t)) {
        positionMetaAttemptedRef.current.delete(t);
      }
    }
    const meta = positionMetaByTokenRef.current;
    const ids = [...openTids].filter(
      (tid) => !(tid in meta) && !positionMetaAttemptedRef.current.has(tid),
    );
    if (ids.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const got = await fetchMarketMetaByClobTokens(ids);
        if (cancelled) {
          return;
        }
        for (const tid of ids) {
          if (!(tid in got)) {
            positionMetaAttemptedRef.current.add(tid);
          }
        }
        setPositionMetaByToken((prev) => ({ ...prev, ...got }));
      } catch {
        for (const tid of ids) {
          positionMetaAttemptedRef.current.add(tid);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [backendPositions]);

  const watchedSlugs = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of backendPositions) {
      if (p.paper || p.state !== "open") {
        continue;
      }
      const sl = sportsSlugForMonitorRow(
        { marketId: p.marketId, tokenId: p.tokenId },
        slugByMarketId,
        urlByMarketId,
        positionMetaByToken,
      );
      if (sl && !seen.has(sl)) {
        seen.add(sl);
        out.push(sl);
      }
    }
    return out;
  }, [backendPositions, slugByMarketId, urlByMarketId, positionMetaByToken]);

  const sportsBySlug = useSportsLiveUpdates(watchedSlugs);

  const [orders, setOrders] = useState<PlaceOrderResult[]>([]);
  const [ordersErr, setOrdersErr] = useState<string | null>(null);
  const [trades, setTrades] = useState<CLOBTradeRow[]>([]);
  const [tradesErr, setTradesErr] = useState<string | null>(null);
  const [tradeMetaByAsset, setTradeMetaByAsset] = useState<Record<string, ClobTokenMarketMeta>>({});
  const resolvedClobTokensRef = useRef(new Set<string>());

  const [reconcile, setReconcile] = useState<ReconcileResponse | null>(null);
  const [reconcileErr, setReconcileErr] = useState<string | null>(null);
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [closeTasks, setCloseTasks] = useState<MonitorCloseTaskRow[]>([]);
  const [closeTasksErr, setCloseTasksErr] = useState<string | null>(null);
  const [closedHist, setClosedHist] = useState<ClosedPositionHistoryRow[]>([]);
  const [closedHistErr, setClosedHistErr] = useState<string | null>(null);
  const [closedMetaByToken, setClosedMetaByToken] = useState<Record<string, ClobTokenMarketMeta>>(
    {},
  );
  const closedMetaByTokenRef = useRef(closedMetaByToken);
  closedMetaByTokenRef.current = closedMetaByToken;
  const closedMetaAttemptedRef = useRef(new Set<string>());
  const [quoteByToken, setQuoteByToken] = useState<Record<string, HomeTickQuote>>({});
  const homeTicksBootstrapRef = useRef(false);
  const autoClosedRef = useRef(new Set<string>());
  /** 避免 interval / 多处同时触发时叠加上百个未完成的 snapshot+positions 请求（同域并发上限后全部卡住）。 */
  const refreshAllPromiseRef = useRef<Promise<void> | null>(null);

  const normalizeSnapshot = useCallback(
    (raw: MonitorSnapshot): MonitorSnapshot => ({
      ...raw,
      positions: Array.isArray(raw.positions) ? raw.positions : [],
    }),
    [],
  );

  const refreshAll = useCallback(async () => {
    if (refreshAllPromiseRef.current) {
      return refreshAllPromiseRef.current;
    }
    const run = (async () => {
      const [snapRes, posRes, ctRes] = await Promise.allSettled([
        fetchMonitorSnapshot(),
        fetchPositions(false),
        fetchMonitorCloseTasks(),
      ]);
      if (snapRes.status === "fulfilled") {
        setSnapshot(normalizeSnapshot(snapRes.value));
        setSnapError(null);
      } else {
        setSnapError((snapRes.reason as Error).message);
      }
      if (posRes.status === "fulfilled") {
        setBackendPositions(posRes.value);
        setPositionsErr(null);
      } else {
        setPositionsErr((posRes.reason as Error).message);
        setBackendPositions([]);
      }
      if (ctRes.status === "fulfilled") {
        setCloseTasks(ctRes.value);
        setCloseTasksErr(null);
      } else {
        setCloseTasksErr((ctRes.reason as Error).message);
        setCloseTasks([]);
      }
      setDataReady(true);
    })();
    refreshAllPromiseRef.current = run;
    run.finally(() => {
      if (refreshAllPromiseRef.current === run) {
        refreshAllPromiseRef.current = null;
      }
    });
    return run;
  }, [normalizeSnapshot]);

  useEffect(() => {
    if (backendPositions.length === 0) {
      homeTicksBootstrapRef.current = false;
      setQuoteByToken({});
    }
  }, [backendPositions.length]);

  /** One-time REST bootstrap if /ws/monitor is slow; live mids come from the same CLOB feed as risk. */
  useEffect(() => {
    if (homeTicksBootstrapRef.current || backendPositions.length === 0) {
      return;
    }
    const tokenIds = [
      ...new Set(
        backendPositions
          .filter((p) => !p.paper && p.tokenId && p.state === "open")
          .map((p) => p.tokenId.trim())
          .filter(Boolean),
      ),
    ];
    if (tokenIds.length === 0) {
      return;
    }
    homeTicksBootstrapRef.current = true;
    void (async () => {
      try {
        const q = await fetchHomeTicks(tokenIds);
        setQuoteByToken(q);
      } catch {
        /* ignore */
      }
    })();
  }, [backendPositions]);

  useEffect(() => {
    void refreshAll();
    const t = window.setInterval(() => void refreshAll(), 60_000);
    return () => window.clearInterval(t);
  }, [refreshAll]);

  const monitorSnapDebounceRef = useRef<number | null>(null);

  useEffect(() => {
    const url = wsMonitorURL();
    let ws: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 2_000;
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(url);
        ws.onopen = () => {
          reconnectDelay = 2_000;
        };
        ws.onmessage = (ev) => {
          try {
            const s = JSON.parse(ev.data as string) as MonitorSnapshot;
            if (s && typeof s.totalCostUsdc === "number") {
              const normalized = normalizeSnapshot(s);
              if (monitorSnapDebounceRef.current !== null) {
                window.clearTimeout(monitorSnapDebounceRef.current);
              }
              monitorSnapDebounceRef.current = window.setTimeout(() => {
                monitorSnapDebounceRef.current = null;
                setSnapshot(normalized);
                setSnapError(null);
              }, 150);
            }
          } catch {
            /* ignore */
          }
        };
        ws.onerror = () => {
          ws?.close();
        };
        ws.onclose = () => {
          if (cancelled) return;
          reconnectTimer = window.setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 1.8, 30_000);
        };
      } catch {
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.8, 30_000);
      }
    };
    connect();
    const onVisibility = () => {
      if (document.visibilityState === "visible" && (!ws || ws.readyState === WebSocket.CLOSED)) {
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        reconnectDelay = 2_000;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (monitorSnapDebounceRef.current !== null) {
        window.clearTimeout(monitorSnapDebounceRef.current);
        monitorSnapDebounceRef.current = null;
      }
      ws?.close();
    };
  }, [normalizeSnapshot]);

  useEffect(() => {
    if (subTab !== "orders") return;
    void (async () => {
      try {
        const r = await fetchCLOBOrders(80);
        setOrders(Array.isArray(r.data) ? r.data : []);
        setOrdersErr(null);
      } catch (e) {
        setOrdersErr((e as Error).message);
        setOrders([]);
      }
    })();
  }, [subTab]);

  const [historyBusy, setHistoryBusy] = useState(false);

  const reloadTrades = useCallback(async () => {
    setHistoryBusy(true);
    try {
      try {
        const r = await fetchCLOBTrades(120);
        setTrades(Array.isArray(r.data) ? r.data : []);
        setTradesErr(null);
      } catch (e) {
        setTradesErr((e as Error).message);
        setTrades([]);
      }
      try {
        const closed = await fetchClosedTradeHistory(120);
        setClosedHist(closed);
        setClosedHistErr(null);
      } catch (e) {
        setClosedHistErr((e as Error).message);
        setClosedHist([]);
      }
    } finally {
      setHistoryBusy(false);
    }
  }, []);

  useEffect(() => {
    if (subTab !== "history") return;
    void reloadTrades();
  }, [subTab, reloadTrades]);

  useEffect(() => {
    if (subTab !== "history" || trades.length === 0) {
      return;
    }
    const need: string[] = [];
    const seen = new Set<string>();
    for (const t of trades) {
      const aid = t.asset_id?.trim();
      if (!aid || seen.has(aid)) {
        continue;
      }
      seen.add(aid);
      if (marketForClobTrade(markets, t)) {
        continue;
      }
      if (resolvedClobTokensRef.current.has(aid)) {
        continue;
      }
      need.push(aid);
    }
    if (need.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const got = await fetchMarketMetaByClobTokens(need);
        if (cancelled) {
          return;
        }
        for (const id of need) {
          resolvedClobTokensRef.current.add(id);
        }
        if (Object.keys(got).length > 0) {
          setTradeMetaByAsset((prev) => ({ ...prev, ...got }));
        }
      } catch {
        for (const id of need) {
          resolvedClobTokensRef.current.add(id);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subTab, trades, markets]);

  useEffect(() => {
    if (subTab !== "history" || closedHist.length === 0) {
      return;
    }
    const histTids = new Set(
      closedHist.map((r) => (r.tokenId || "").trim()).filter((tid): tid is string => Boolean(tid)),
    );
    for (const t of [...closedMetaAttemptedRef.current]) {
      if (!histTids.has(t)) {
        closedMetaAttemptedRef.current.delete(t);
      }
    }
    const cmeta = closedMetaByTokenRef.current;
    const need = [...histTids].filter(
      (tid) => !(tid in cmeta) && !closedMetaAttemptedRef.current.has(tid),
    );
    if (need.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const got = await fetchMarketMetaByClobTokens(need);
        if (cancelled) {
          return;
        }
        for (const tid of need) {
          if (!(tid in got)) {
            closedMetaAttemptedRef.current.add(tid);
          }
        }
        if (Object.keys(got).length > 0) {
          setClosedMetaByToken((prev) => ({ ...prev, ...got }));
        }
      } catch {
        for (const tid of need) {
          closedMetaAttemptedRef.current.add(tid);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subTab, closedHist]);

  const loadReconcile = useCallback(async () => {
    setReconcileBusy(true);
    try {
      const r = await fetchReconcile();
      setReconcile(r);
      setReconcileErr(null);
    } catch (e) {
      setReconcileErr((e as Error).message);
      setReconcile(null);
    } finally {
      setReconcileBusy(false);
    }
  }, []);

  useEffect(() => {
    if (subTab !== "reconcile") return;
    void loadReconcile();
  }, [subTab, loadReconcile]);

  const liveRows = useMemo(
    () => mergeDisplayRows(backendPositions, snapshot),
    [backendPositions, snapshot],
  );

  const backendById = useMemo(
    () => new Map(backendPositions.map((p) => [p.id, p])),
    [backendPositions],
  );

  const enrichedRows = useMemo(() => {
    return liveRows.map((row) => {
      let mid = row.mid ?? 0;
      let bid = row.bid ?? 0;
      let ask = row.ask ?? 0;
      if (mid <= 0 && row.tokenId) {
        const hq = midFromHomeQuote(quoteByToken[row.tokenId]);
        if (hq > 0) {
          mid = hq;
          const q = quoteByToken[row.tokenId];
          if (q) {
            bid = Number(q.bestBid) || bid;
            ask = Number(q.bestAsk) || ask;
          }
        }
      }
      if (mid <= 0 && row.tokenId) {
        const mk = markets.find((m) => m.id === row.marketId);
        const fm = midFromMarketBook(mk, row.tokenId);
        if (fm > 0) {
          mid = fm;
        }
      }
      const bp = backendById.get(row.id);
      const costUsdc =
        row.costUsdc > 0
          ? row.costUsdc
          : bp?.costUsdc && bp.costUsdc > 0
            ? bp.costUsdc
            : row.costUsdc;
      const unrealizedMidUsdc = row.shares > 0 && mid > 0 ? row.shares * mid - costUsdc : 0;
      return { ...row, mid, bid, ask, costUsdc, unrealizedMidUsdc };
    });
  }, [liveRows, quoteByToken, markets, backendById]);

  /** 赛事实况已结束、或盘口已无有效现价（多为已结算）的持仓不展示；已止损不在 merge 中。 */
  const visibleRows = useMemo(() => {
    return enrichedRows.filter((row) => {
      const slug = sportsSlugForMonitorRow(
        { marketId: row.marketId, tokenId: row.tokenId },
        slugByMarketId,
        urlByMarketId,
        positionMetaByToken,
      );
      if (slug) {
        const live = sportsBySlug[slug];
        if (live?.ended === true) return false;
      }
      const mid = row.mid ?? 0;
      const bp = backendById.get(row.id);
      const entryPx = effectiveEntryPrice(row, bp);
      const costForDust = row.costUsdc > 0 ? row.costUsdc : (bp?.costUsdc ?? 0);
      if (row.state === "open" && entryPx >= 0.02 && mid < 0.005 && costForDust > 0) {
        return false;
      }
      return true;
    });
  }, [enrichedRows, slugByMarketId, sportsBySlug, urlByMarketId, positionMetaByToken, backendById]);

  useEffect(() => {
    if (backendPositions.length === 0) {
      autoClosedRef.current.clear();
      return;
    }
    const byID = backendById;
    const candidates = enrichedRows.filter((row) => {
      const bp = byID.get(row.id);
      if (!bp || bp.paper || bp.state !== "open") {
        return false;
      }
      const slug = sportsSlugForMonitorRow(
        { marketId: row.marketId, tokenId: row.tokenId },
        slugByMarketId,
        urlByMarketId,
        positionMetaByToken,
      );
      const live = slug ? sportsBySlug[slug] : undefined;
      if (live?.ended === true) {
        return true;
      }
      const mid = row.mid ?? 0;
      const entryPx = effectiveEntryPrice(row, bp);
      const costForDust = row.costUsdc > 0 ? row.costUsdc : bp.costUsdc;
      return entryPx >= 0.02 && mid < 0.005 && costForDust > 0;
    });
    if (candidates.length === 0) {
      return;
    }
    void (async () => {
      let changed = false;
      for (const row of candidates) {
        if (autoClosedRef.current.has(row.id)) {
          continue;
        }
        autoClosedRef.current.add(row.id);
        try {
          await closeBackendPosition(row.id);
          changed = true;
        } catch {
          autoClosedRef.current.delete(row.id);
        }
      }
      if (changed) {
        await refreshAll();
      }
    })();
  }, [
    backendPositions,
    backendById,
    enrichedRows,
    refreshAll,
    slugByMarketId,
    sportsBySlug,
    urlByMarketId,
    positionMetaByToken,
  ]);

  const hasAnyOpenBackend = useMemo(
    () => backendPositions.some((p) => !p.paper && p.state === "open"),
    [backendPositions],
  );

  const stoppedCount = useMemo(
    () => backendPositions.filter((p) => !p.paper && p.state === "stopped_out").length,
    [backendPositions],
  );

  const totalInvest = useMemo(() => {
    const v = visibleRows.reduce((s, r) => s + r.costUsdc, 0);
    if (v > 0) return v;
    if (snapshot && snapshot.totalCostUsdc > 0) return snapshot.totalCostUsdc;
    return backendPositions
      .filter((p) => !p.paper && p.state === "open")
      .reduce((s, p) => s + p.costUsdc, 0);
  }, [visibleRows, snapshot, backendPositions]);

  const totalPnl = useMemo(() => {
    const fromVisible = visibleRows.reduce((s, r) => s + (r.unrealizedMidUsdc ?? 0), 0);
    if (visibleRows.length > 0) return fromVisible;
    if (snapshot == null) return fromVisible;
    const snapMissing = snapshot.positions?.some((p) => (p.mid ?? 0) <= 0);
    if (snapMissing) return fromVisible;
    return snapshot.unrealizedMidUsdc;
  }, [snapshot, visibleRows]);

  const openOrderRows = useMemo(() => {
    return orders.filter((o) => {
      const st = String(o.status ?? "").toUpperCase();
      return st === "LIVE" || st === "OPEN";
    });
  }, [orders]);

  const [sellingId, setSellingId] = useState<string | null>(null);
  const [disarmingId, setDisarmingId] = useState<string | null>(null);

  const disarmRow = async (row: MonitorSnapshotPositionRow) => {
    setDisarmingId(row.id);
    try {
      await disarmPosition(row.id);
      await refreshAll();
    } catch (e) {
      setSnapError((e as Error).message);
    } finally {
      setDisarmingId(null);
    }
  };

  const sellRow = async (row: MonitorSnapshotPositionRow) => {
    if (!row.tokenId || row.shares <= 0) return;
    setSellingId(row.id);
    try {
      await marketSell({ tokenId: row.tokenId, shares: row.shares });
      await closeBackendPosition(row.id);
      await refreshAll();
    } catch (e) {
      setSnapError((e as Error).message);
    } finally {
      setSellingId(null);
    }
  };

  const [editingStopId, setEditingStopId] = useState<string | null>(null);
  const [editingStopVal, setEditingStopVal] = useState<string>("");

  const startEditStop = (row: MonitorSnapshotPositionRow) => {
    setEditingStopId(row.id);
    setEditingStopVal(String(row.stopTrailPct > 1 ? row.stopTrailPct : row.stopTrailPct * 100));
  };

  const saveStopEdit = async (rowId: string) => {
    let v = parseFloat(editingStopVal);
    if (!Number.isFinite(v) || v <= 0) {
      setEditingStopId(null);
      return;
    }
    if (v > 1) v = v / 100;
    try {
      await updatePosition(rowId, { stopTrailPct: v });
      await refreshAll();
    } catch (e) {
      setSnapError((e as Error).message);
    } finally {
      setEditingStopId(null);
    }
  };

  return (
    <div className="space-y-6">
      {snapError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          快照: {snapError}
        </div>
      ) : null}
      {positionsErr ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          持仓 API: {positionsErr}（请确认 VITE_BACKEND_BASE_URL 指向正在运行的后端）
        </div>
      ) : null}
      {closeTasksErr ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
          平仓重试队列 API: {closeTasksErr}
        </div>
      ) : null}
      {closeTasks.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-amber-500/35 bg-amber-500/10">
          <div className="border-b border-amber-500/25 px-4 py-2 text-sm font-medium text-amber-950 dark:text-amber-100">
            风控平仓重试队列（CLOB 卖出失败后会自动重试，直至成功）
          </div>
          <div className="overflow-x-auto px-2 py-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">类型</TableHead>
                  <TableHead className="font-mono text-xs">仓位 ID</TableHead>
                  <TableHead className="text-right">失败次数</TableHead>
                  <TableHead className="min-w-[160px]">上次错误</TableHead>
                  <TableHead className="whitespace-nowrap">下次重试</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closeTasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-sm">{closeTaskKindZh(t.kind)}</TableCell>
                    <TableCell className="max-w-[140px] truncate font-mono text-xs">
                      {t.positionId}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{t.failCount}</TableCell>
                    <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground">
                      {t.lastError || "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {t.nextRetryAt ? new Date(t.nextRetryAt).toLocaleString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label="持仓总投入" value={formatUSD(totalInvest)} />
        <StatCard
          label="当前总浮盈"
          value={formatUSD(totalPnl)}
          tone={totalPnl >= 0 ? "profit" : "loss"}
          hint={totalInvest > 0 ? formatPct((totalPnl / totalInvest) * 100) : "—"}
        />
        <StatCard label="已止损场次" value={String(stoppedCount)} tone="warning" />
      </div>

      {watchedSlugs.length > 0 ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-muted-foreground">
          赛事实况（Sports WS）已订阅 {watchedSlugs.length} 场 · 比分与节次来自{" "}
          <code className="rounded bg-muted px-1">wss://sports-api.polymarket.com/ws</code>
        </div>
      ) : null}

      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as SubTab)} className="w-full">
        <TabsList className="grid w-full max-w-3xl grid-cols-2 gap-1 sm:grid-cols-4">
          <TabsTrigger value="positions">持仓</TabsTrigger>
          <TabsTrigger value="orders">未成交订单</TabsTrigger>
          <TabsTrigger value="history">历史记录</TabsTrigger>
          <TabsTrigger value="reconcile">对账</TabsTrigger>
        </TabsList>

        <TabsContent value="positions" className="mt-4">
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b px-4 py-2 text-sm font-medium">实时持仓</div>
            <div className="overflow-x-auto">
              {!dataReady ? (
                <div className="p-8 text-center text-sm text-muted-foreground">加载中…</div>
              ) : visibleRows.length === 0 && hasAnyOpenBackend ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  当前没有在「实时持仓」中展示的场次（已结束或已止损的持仓已从此列表隐藏）。需要核对链上记录请查看「对账」或「历史记录」。
                </div>
              ) : visibleRows.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">
                  暂无持仓，去「赛事交易」下单。若已下单仍为空，请确认浏览器访问的后端与下单为同一地址。
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[220px] whitespace-nowrap">盘口</TableHead>
                      <TableHead className="whitespace-nowrap text-right">均价 → 现价</TableHead>
                      <TableHead className="whitespace-nowrap text-right">交易金额</TableHead>
                      <TableHead className="whitespace-nowrap text-right">可赢利金额</TableHead>
                      <TableHead className="whitespace-nowrap text-right">价值</TableHead>
                      <TableHead className="whitespace-nowrap text-right">高水位</TableHead>
                      <TableHead
                        className="whitespace-nowrap text-right"
                        title="相对最高水位的回撤比例；买一价跌至此触发系统止损（随价格上涨而上移）"
                      >
                        止损价
                      </TableHead>
                      <TableHead className="whitespace-nowrap text-right">止损</TableHead>
                      <TableHead className="whitespace-nowrap text-right">状态</TableHead>
                      <TableHead className="whitespace-nowrap text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.map((p) => {
                      const mid = p.mid ?? 0;
                      const bpRow = backendById.get(p.id);
                      const entryPx = effectiveEntryPrice(p, bpRow);
                      const markValue = p.shares > 0 && mid > 0 ? p.shares * mid : 0;
                      const potentialWin = p.shares > 0 ? p.shares * 1 : 0;
                      const trailPct =
                        p.stopTrailPct > 0
                          ? p.stopTrailPct <= 1
                            ? p.stopTrailPct * 100
                            : p.stopTrailPct
                          : 20;
                      const stopTriggerPx = trailingStopTriggerPx(
                        p.highWaterMark,
                        entryPx,
                        p.stopTrailPct,
                      );
                      const meta = p.tokenId ? positionMetaByToken[p.tokenId.trim()] : undefined;
                      const disp = displayForMonitorRow(
                        p,
                        meta,
                        markets,
                        questionByMarketId,
                        urlByMarketId,
                        slugByMarketId,
                      );
                      const lbl = (p.outcomeLabel || "").trim();
                      const pmURL = disp.url;
                      const slugKey = sportsSlugForMonitorRow(
                        { marketId: p.marketId, tokenId: p.tokenId },
                        slugByMarketId,
                        urlByMarketId,
                        positionMetaByToken,
                      );
                      const live = slugKey ? sportsBySlug[slugKey] : undefined;
                      const matchEnded = live?.ended === true;
                      const monitoringOn = p.monitoringActive && p.state === "open";
                      return (
                        <TableRow key={p.id}>
                          <TableCell>
                            <div className="min-w-0 max-w-[min(28rem,72vw)]">
                              <div className="flex flex-wrap items-start gap-x-2 gap-y-1 leading-tight">
                                <div className="min-w-0 font-medium">
                                  {pmURL ? (
                                    <a
                                      href={pmURL}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline text-xs font-medium text-primary hover:underline"
                                      title="在 Polymarket 官网打开该赛事"
                                    >
                                      {disp.headline}
                                    </a>
                                  ) : (
                                    <span className="text-xs font-medium">{disp.headline}</span>
                                  )}
                                </div>
                                <LiveEventMark update={live} className="shrink-0 font-normal" />
                              </div>
                              {disp.subtitle ? (
                                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                                  {disp.subtitle}
                                </div>
                              ) : null}
                              {disp.metaLine ? (
                                <div className="mt-1 text-[11px] text-muted-foreground">
                                  {disp.metaLine}
                                </div>
                              ) : null}
                              {(() => {
                                if (
                                  !live ||
                                  (!live.score &&
                                    !live.period &&
                                    !live.elapsed &&
                                    live.live !== true &&
                                    live.ended !== true)
                                ) {
                                  return null;
                                }
                                return (
                                  <div className="mt-1 text-[11px] text-muted-foreground">
                                    实况 {live.score ?? "—"}
                                    {live.period ? ` · ${live.period}` : ""}
                                    {live.elapsed ? ` · ${live.elapsed}` : ""}
                                    {live.ended ? " · 已结束" : ""}
                                  </div>
                                );
                              })()}
                              <div className="mt-1 flex flex-wrap items-center gap-2">
                                {lbl ? (
                                  <Badge
                                    variant="secondary"
                                    className="rounded-md bg-amber-500/15 px-2 py-0 text-[11px] font-medium text-amber-900 dark:text-amber-100"
                                  >
                                    {lbl} {formatProbPriceCents(entryPx)}
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="secondary"
                                    className="rounded-md px-2 py-0 text-[11px]"
                                  >
                                    {formatProbPriceCents(entryPx)}
                                  </Badge>
                                )}
                                <span className="text-[11px] text-muted-foreground">
                                  {p.shares >= 10
                                    ? `${p.shares.toFixed(1)} 份额`
                                    : `${p.shares.toFixed(2)} 份额`}
                                </span>
                                <span
                                  className={cn(
                                    "text-[11px]",
                                    monitoringOn ? "text-primary" : "text-muted-foreground",
                                  )}
                                >
                                  {monitoringOn ? "监控中" : "未监控"}
                                </span>
                                {(() => {
                                  const bp = backendPositions.find((b) => b.id === p.id);
                                  return bp?.external ? (
                                    <Badge
                                      variant="outline"
                                      className="rounded-md border-blue-500/40 px-2 py-0 text-[11px] text-blue-900 dark:text-blue-100"
                                    >
                                      外部
                                    </Badge>
                                  ) : null;
                                })()}
                                {matchEnded ? (
                                  <Badge
                                    variant="outline"
                                    className="rounded-md border-amber-500/40 px-2 py-0 text-[11px] text-amber-900 dark:text-amber-100"
                                  >
                                    赛事已关闭
                                  </Badge>
                                ) : null}
                                {p.monitoringActive ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-[11px] text-muted-foreground"
                                    disabled={disarmingId === p.id}
                                    onClick={() => void disarmRow(p)}
                                    title="停止该持仓的移动止损风控监控"
                                  >
                                    {disarmingId === p.id ? "…" : "移除监控"}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {formatProbPriceCents(entryPx)} → {formatProbPriceCents(mid)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUSD(p.costUsdc)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatUSD(potentialWin)}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="font-semibold tabular-nums">{formatUSD(markValue)}</div>
                            <div
                              className={cn(
                                "text-[11px] tabular-nums",
                                p.unrealizedMidUsdc >= 0
                                  ? "text-[color:var(--profit)]"
                                  : "text-[color:var(--loss)]",
                              )}
                            >
                              {formatUSD(p.unrealizedMidUsdc)}{" "}
                              {entryPx > 0 ? formatPct(((mid - entryPx) / entryPx) * 100) : ""}
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {formatPrice(p.highWaterMark)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm">
                            {stopTriggerPx > 0 ? formatProbPriceCents(stopTriggerPx) : "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {editingStopId === p.id ? (
                              <div className="flex items-center justify-end gap-1">
                                <input
                                  type="number"
                                  min={1}
                                  max={99}
                                  value={editingStopVal}
                                  onChange={(e) => setEditingStopVal(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") void saveStopEdit(p.id);
                                    if (e.key === "Escape") setEditingStopId(null);
                                  }}
                                  onBlur={() => void saveStopEdit(p.id)}
                                  className="w-12 rounded border px-1 py-0.5 text-right text-xs tabular-nums"
                                  autoFocus
                                />
                                <span className="text-xs">%</span>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="cursor-pointer text-xs tabular-nums hover:text-primary"
                                onClick={() => startEditStop(p)}
                                title="点击修改止损比例"
                              >
                                {trailPct.toFixed(0)}%
                              </button>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <span
                              className={cn(
                                "rounded-md px-2 py-0.5 text-[11px] font-medium",
                                p.state === "stopped_out"
                                  ? "bg-[color:var(--loss)]/15 text-[color:var(--loss)]"
                                  : "bg-[color:var(--profit)]/15 text-[color:var(--profit)]",
                              )}
                            >
                              {p.state === "stopped_out" ? "已止损" : "持有中"}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={sellingId === p.id || p.state !== "open"}
                              onClick={() => void sellRow(p)}
                            >
                              {sellingId === p.id ? "…" : "卖出"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="orders" className="mt-4">
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b px-4 py-2 text-sm font-medium">
              未成交订单（CLOB LIVE / OPEN）
            </div>
            {ordersErr ? (
              <div className="p-6 text-sm text-destructive">{ordersErr}</div>
            ) : openOrderRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                暂无未成交挂单，或尚未拉取到数据。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>订单</TableHead>
                      <TableHead className="text-right">价格</TableHead>
                      <TableHead className="text-right">数量</TableHead>
                      <TableHead className="text-right">已成交</TableHead>
                      <TableHead className="text-right">状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {openOrderRows.map((o, i) => (
                      <TableRow key={(o.orderID || o.id || String(i)) as string}>
                        <TableCell className="max-w-[280px] truncate font-mono text-xs">
                          {(o.orderID || o.id) as string}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{o.price ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {o.original_size ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {o.size_matched ?? "—"}
                        </TableCell>
                        <TableCell className="text-right text-sm">{o.status ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="reconcile" className="mt-4">
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
              <div className="text-sm font-medium">本地 vs Data API 持仓对账</div>
              <Button
                size="sm"
                variant="secondary"
                disabled={reconcileBusy}
                onClick={() => void loadReconcile()}
              >
                {reconcileBusy ? "刷新中…" : "刷新"}
              </Button>
            </div>
            {reconcileErr ? (
              <div className="p-6 text-sm text-destructive">{reconcileErr}</div>
            ) : !reconcile ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {reconcileBusy ? "加载中…" : "无数据"}
              </div>
            ) : (
              <div className="space-y-3 p-4">
                {reconcile.proxy ? (
                  <div className="text-xs text-muted-foreground">
                    Proxy（Safe）: <span className="font-mono">{reconcile.proxy}</span>
                  </div>
                ) : null}
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[120px]">Token</TableHead>
                        <TableHead className="min-w-[100px]">Local ID</TableHead>
                        <TableHead className="text-right">本地份额</TableHead>
                        <TableHead className="text-right">链上份额</TableHead>
                        <TableHead className="text-center">漂移</TableHead>
                        <TableHead>说明</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {reconcile.rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground">
                            无差异行（或暂无持仓）
                          </TableCell>
                        </TableRow>
                      ) : (
                        reconcile.rows.map((row, i) => (
                          <TableRow key={`${row.tokenId}-${row.localId ?? i}`}>
                            <TableCell className="max-w-[200px] truncate font-mono text-xs">
                              {row.tokenId}
                            </TableCell>
                            <TableCell className="max-w-[120px] truncate font-mono text-xs">
                              {row.localId ?? "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.localShares.toFixed(4)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.chainShares != null ? row.chainShares.toFixed(4) : "—"}
                            </TableCell>
                            <TableCell className="text-center">
                              {row.drift ? (
                                <Badge variant="destructive" className="text-[10px]">
                                  是
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="text-[10px]">
                                  否
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {row.note ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-4 space-y-6">
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="border-b px-4 py-2 text-sm font-medium">已结束仓位（本地 SQLite）</div>
            {closedHistErr ? (
              <div className="p-4 text-sm text-muted-foreground">
                本地历史：{closedHistErr}（未配置或无法访问{" "}
                <code className="rounded bg-muted px-1">TRADE_HISTORY_DB</code> 时为空）
              </div>
            ) : closedHist.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                暂无已入库的结束记录。系统止损或手动平仓/卖出后，会写入服务端 SQLite。
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[140px]">时间</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead className="min-w-[120px]">市场</TableHead>
                      <TableHead className="text-right">份额</TableHead>
                      <TableHead className="text-right">投入</TableHead>
                      <TableHead className="text-right">开仓价</TableHead>
                      <TableHead className="text-right">平仓价</TableHead>
                      <TableHead className="text-right">高水位</TableHead>
                      <TableHead className="max-w-[100px] truncate font-mono text-xs">
                        订单
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {closedHist.map((row) => (
                      <TableRow key={`${row.positionId}-${row.closedAt}`}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {row.closedAt ? new Date(row.closedAt).toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="text-sm">{closeReasonZh(row.closeReason)}</TableCell>
                        <TableCell className="max-w-[220px] text-sm">
                          {(() => {
                            const meta = (row.tokenId || "").trim()
                              ? closedMetaByToken[row.tokenId.trim()]
                              : undefined;
                            const title =
                              meta?.eventTitle?.trim() ||
                              meta?.question?.trim() ||
                              questionByMarketId.get(row.marketId ?? "") ||
                              (row.marketId
                                ? `Market ${row.marketId}`
                                : row.tokenId.slice(0, 12) + "…");
                            const pmUrl =
                              meta?.polymarketUrl?.trim() ||
                              (meta?.eventSlug?.trim()
                                ? `https://polymarket.com/event/${meta.eventSlug.trim()}`
                                : null);
                            return pmUrl ? (
                              <a
                                href={pmUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="truncate font-medium text-primary hover:underline"
                                title="打开 Polymarket 官网"
                              >
                                {title}
                              </a>
                            ) : (
                              <div className="truncate font-medium">{title}</div>
                            );
                          })()}
                          {row.outcomeLabel ? (
                            <div className="truncate text-[11px] text-muted-foreground">
                              {row.outcomeLabel}
                            </div>
                          ) : null}
                          {row.paper ? (
                            <Badge variant="outline" className="mt-1 text-[10px]">
                              模拟
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {row.shares >= 10 ? row.shares.toFixed(1) : row.shares.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {formatUSD(row.costUsdc)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {formatProbPriceCents(row.avgEntryPrice)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {row.lastBid && row.lastBid > 0
                            ? formatProbPriceCents(row.lastBid)
                            : row.lastMid && row.lastMid > 0
                              ? formatProbPriceCents(row.lastMid)
                              : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm text-muted-foreground">
                          {formatPrice(row.highWaterMark)}
                        </TableCell>
                        <TableCell className="max-w-[100px] truncate font-mono text-[10px]">
                          {row.orderId || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
          <ClobTradeHistory
            trades={trades}
            error={tradesErr}
            loading={historyBusy}
            markets={markets}
            tradeMetaByAsset={tradeMetaByAsset}
            onRefresh={reloadTrades}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
