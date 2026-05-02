import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  LayoutGrid,
  Loader2,
  RefreshCw,
  ShoppingCart,
  Table2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useMarketStore, useParamsStore, usePositionsStore, useWalletStore } from "@/lib/store";
import { armPosition, fetchBasketballMarkets, startMonitorFeed } from "@/lib/polymarket";
import {
  computeSuggestedAmounts,
  formatNBATipOffET,
  formatPrice,
  formatProbPriceCents,
  formatSpreadWidthCents,
  formatUSD,
  passesDepthCheck,
} from "@/lib/calc";
import {
  effectiveMarketParams,
  LOCK_CROSS_MARKET_UI_PARAMS,
  LOCKED_DEFAULT_STOP_LOSS_PCT,
} from "@/lib/productFlags";
import type { Market, TierConfig } from "@/lib/types";
import {
  baseMatchTitle,
  groupMarketsForDisplay,
  orderLegsForDisplay,
  outcomeShortLabel,
  sortGameRows,
  type GameRow,
} from "@/lib/gameRows";
import { orderIdFromResponse, parseMarketBuyFill } from "@/lib/orderFill";
import { sportsSlugForWsWatch, useSportsLiveUpdates } from "@/lib/sportsWs";
import { cn } from "@/lib/utils";
import { LiveEventMark } from "@/components/LiveEventMark";
import { toast } from "sonner";
import {
  closeAllTrading,
  getOrder,
  placeMarketBuy,
  registerBackendPosition,
} from "@/lib/tradingApi";
import { useBoardPriceStream } from "@/lib/useBoardPriceStream";

/** 可交易筛选：热门侧现价 ≤ 90¢（即 decimal ≤ 0.90） */
const TRADEABLE_MAX_PRICE = 0.9;

function isGameTradeable(row: GameRow): boolean {
  const top = orderLegsForDisplay(row.legs)[0];
  if (!top) return false;
  return top.midPrice <= TRADEABLE_MAX_PRICE;
}

function suggestedInputClass(m: Market, amount: number, size: "sm" | "md" = "sm") {
  const filled = m.midPrice > 0.5 && amount > 0;
  return cn(
    "text-right tabular-nums",
    size === "sm" && "h-7 w-24",
    size === "md" && "h-8 w-28",
    filled && "border-emerald-500/40 bg-emerald-500/10 dark:bg-emerald-500/15",
  );
}

/** 热门侧所在价格区间（全局参数里的 A/B/C），展示在「赛事」列 */
function favoriteTierCaption(favorite: Market, tiers: TierConfig[]): string {
  if (!favorite.tier) return "价格区间：未命中 A / B / C（热门侧不在配置区间内）";
  const cfg = tiers.find((x) => x.id === favorite.tier);
  if (!cfg) return "价格区间：—";
  return `区间 ${favorite.tier} · ${cfg.label} ${formatProbPriceCents(cfg.min)} – ${formatProbPriceCents(cfg.max)} · 占资金 ${cfg.allocPct}%`;
}

function PolymarketLink({ url }: { url?: string }) {
  if (!url) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
    >
      open market
      <ChevronRight className="size-3 shrink-0" aria-hidden />
    </a>
  );
}

/** 赛事列表 REST 轮询间隔；与监控模块快照轮询无关。 */
const HOME_MARKETS_POLL_MS = 60_000;

export function MarketsTab() {
  const params = useParamsStore((s) => s.params);
  const effParams = useMemo(() => effectiveMarketParams(params), [params]);
  const wallet = useWalletStore();
  const {
    markets,
    openPrices,
    lastUpdated,
    loading,
    error,
    setMarkets,
    patchMarket,
    setLoading,
    setError,
  } = useMarketStore();
  const { open: openPosition, positions } = usePositionsStore();

  const [refreshing, setRefreshing] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "card">("table");
  /** Single-row buy in flight */
  const [pendingMarketId, setPendingMarketId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const [listFilter, setListFilter] = useState<"all" | "tradeable">("all");
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }
    const run = (async () => {
      setRefreshing(true);
      setLoading(true);
      setError(null);
      try {
        const fresh = await fetchBasketballMarkets(params, openPrices);
        const withAmounts = computeSuggestedAmounts(fresh, effParams, wallet.usdcBalance);
        setMarkets(withAmounts);
      } catch (e) {
        setError((e as Error).message || "拉取行情失败");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    })();
    refreshPromiseRef.current = run;
    run.finally(() => {
      if (refreshPromiseRef.current === run) {
        refreshPromiseRef.current = null;
      }
    });
    return run;
  }, [effParams, openPrices, params, setError, setLoading, setMarkets, wallet.usdcBalance]);

  useEffect(() => {
    if (markets.length === 0) void refresh();
    const id = setInterval(refresh, HOME_MARKETS_POLL_MS);
    return () => clearInterval(id);
  }, [markets.length, refresh]);

  // 重新计算建议金额（依赖参数 / 余额变化）
  const enriched = useMemo(
    () => computeSuggestedAmounts(markets, effParams, wallet.usdcBalance),
    [markets, effParams, wallet.usdcBalance],
  );

  const { connected: boardLive } = useBoardPriceStream(enriched);

  /** 不按区间分块；整表按开赛时间（早 → 晚）排列 */
  const flatGameRows = useMemo(
    () => sortGameRows(groupMarketsForDisplay(enriched), "start", "asc"),
    [enriched],
  );

  const eventSlugsForSportsWs = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const row of flatGameRows) {
      const sl = sportsSlugForWsWatch(row.favorite);
      if (sl && !seen.has(sl)) {
        seen.add(sl);
        out.push(sl);
      }
    }
    return out;
  }, [flatGameRows]);

  const sportsLiveBySlug = useSportsLiveUpdates(eventSlugsForSportsWs);

  const allGameCount = flatGameRows.length;
  const tradeableGameCount = useMemo(
    () => flatGameRows.filter(isGameTradeable).length,
    [flatGameRows],
  );

  const filteredGameRows = useMemo(
    () => (listFilter === "all" ? flatGameRows : flatGameRows.filter(isGameTradeable)),
    [flatGameRows, listFilter],
  );

  const visibleMarketIds = useMemo(() => {
    const ids = new Set<string>();
    for (const row of filteredGameRows) {
      for (const leg of row.legs) {
        ids.add(leg.id);
      }
    }
    return ids;
  }, [filteredGameRows]);

  const hasAnyGames = flatGameRows.length > 0;
  const hasDisplayRows = filteredGameRows.length > 0;

  const totalPlanned = useMemo(
    () =>
      enriched
        .filter((m) => visibleMarketIds.has(m.id))
        .reduce((s, m) => s + (m.customAmount ?? m.suggestedAmount), 0),
    [enriched, visibleMarketIds],
  );
  const heldIds = new Set(positions.filter((p) => p.status === "bought").map((p) => p.marketId));

  /** Backend CLOB buy + register monitor position + local UI state. */
  const submitBuy = async (m: Market) => {
    const amount = m.customAmount ?? m.suggestedAmount;
    if (amount <= 0) return;
    const tokenId = m.yesTokenId?.trim();
    if (!tokenId) {
      throw new Error("该市场缺少 outcome token，无法下单");
    }
    const entry = m.bestAsk > 0 ? m.bestAsk : m.midPrice;
    if (!(entry > 0)) {
      throw new Error("盘口价格无效");
    }
    const tier = m.tier ?? "C";
    const tierCfg = params.tiers.find((t) => t.id === tier);
    if (!tierCfg) {
      throw new Error("区间配置缺失");
    }
    const stopLoss = LOCK_CROSS_MARKET_UI_PARAMS
      ? (tierCfg.defaultStopLoss ?? LOCKED_DEFAULT_STOP_LOSS_PCT)
      : (m.customStopLoss ?? tierCfg.defaultStopLoss ?? params.externalDefaultStopLossPct);
    const trailFrac = stopLoss > 1 ? stopLoss / 100 : stopLoss;

    const orderResp = await placeMarketBuy({
      tokenId,
      amountUsdc: amount,
      idempotencyKey: crypto.randomUUID(),
    });

    let fill = parseMarketBuyFill(orderResp as Record<string, unknown>, amount, entry);
    const oid = orderIdFromResponse(orderResp as Record<string, unknown>);
    if (oid) {
      try {
        const refreshed = await getOrder(oid);
        fill = parseMarketBuyFill(refreshed as Record<string, unknown>, amount, entry);
      } catch {
        /* 使用首次返回的成交字段 */
      }
    }

    const reg = await registerBackendPosition({
      marketId: m.id,
      conditionId: m.conditionId,
      eventId: m.eventId,
      tokenId,
      shares: fill.shares,
      avgEntryPrice: fill.avgPrice,
      costUsdc: fill.costUsdc,
      stopTrailPct: trailFrac,
      outcomeLabel: outcomeShortLabel(m),
      paper: false,
    });

    await armPosition(reg.id);
    try {
      await startMonitorFeed();
    } catch {
      /* no other positions yet or feed error — user can start from 测试 tab */
    }

    openPosition({
      backendPositionId: reg.id,
      outcomeLabel: outcomeShortLabel(m),
      marketId: m.id,
      tokenId,
      question: m.question,
      league: m.league,
      tier,
      side: "YES",
      entryPrice: fill.avgPrice,
      currentPrice: fill.avgPrice,
      highWaterMark: fill.avgPrice,
      amountUSDC: fill.costUsdc,
      shares: fill.shares,
      stopLossPct: stopLoss,
      status: "bought",
      pnl: 0,
      pnlPct: 0,
      createdAt: Date.now(),
    });
  };

  const buyMarket = async (m: Market) => {
    if (pendingMarketId || batchBusy) return;
    setPendingMarketId(m.id);
    try {
      await submitBuy(m);
      toast.success("买入已提交", { description: m.question.slice(0, 80) });
    } catch (e) {
      toast.error((e as Error).message || "下单失败");
    } finally {
      setPendingMarketId(null);
    }
  };

  const clearAllAmounts = () => {
    if (batchBusy || closeBusy || pendingMarketId) return;
    for (const m of markets) {
      patchMarket(m.id, { customAmount: 0 });
    }
    toast.success("已清空", { description: "所有盘口的建议金额已设为 0" });
  };

  const fillAllByRules = () => {
    if (batchBusy || closeBusy || pendingMarketId) return;
    const next = computeSuggestedAmounts(markets, effParams, wallet.usdcBalance);
    for (const m of next) {
      patchMarket(m.id, { customAmount: m.suggestedAmount });
    }
    toast.success("已填充", { description: "已按资金池与区间规则写入建议金额" });
  };

  const buyAll = async () => {
    const legs: Market[] = [];
    for (const row of filteredGameRows) {
      for (const m of orderLegsForDisplay(row.legs)) {
        if (heldIds.has(m.id)) continue;
        if (!passesDepthCheck(m, effParams)) continue;
        if (m.spread > effParams.maxSpread) continue;
        if ((m.customAmount ?? m.suggestedAmount) <= 0) continue;
        if (!m.yesTokenId?.trim()) continue;
        legs.push(m);
      }
    }
    if (legs.length === 0) {
      toast.message("没有可批量买入的盘口（检查金额、价差、深度）");
      return;
    }
    setBatchBusy(true);
    let ok = 0;
    const errs: string[] = [];
    for (const m of legs) {
      try {
        await submitBuy(m);
        ok++;
      } catch (e) {
        errs.push(`${outcomeShortLabel(m)}: ${(e as Error).message}`);
      }
    }
    setBatchBusy(false);
    if (errs.length === 0) {
      toast.success(`批量买入完成`, { description: `成功 ${ok} 笔` });
    } else {
      toast.warning(`批量买入结束：成功 ${ok}，失败 ${errs.length}`, {
        description: errs.slice(0, 3).join("；") + (errs.length > 3 ? "…" : ""),
      });
    }
  };

  const handleCloseAll = async () => {
    const bought = positions.filter((p) => p.status === "bought" && p.tokenId && p.shares > 0);
    if (bought.length === 0) {
      usePositionsStore.getState().closeAll();
      toast.message("本地无持仓");
      return;
    }
    setCloseBusy(true);
    try {
      await closeAllTrading(
        bought.map((p) => ({ tokenId: p.tokenId as string, shares: p.shares })),
      );
      usePositionsStore.getState().closeAll();
      toast.success("平仓请求已提交", { description: `${bought.length} 个 outcome` });
    } catch (e) {
      toast.error((e as Error).message || "平仓失败");
    } finally {
      setCloseBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">明日篮球赛事</h2>
          <p className="text-xs text-muted-foreground">
            <span>
              {lastUpdated ? `已更新 ${new Date(lastUpdated).toLocaleTimeString()}` : "尚未拉取"}
            </span>
            {" · 盘口 "}
            <span className={boardLive ? "text-emerald-600 dark:text-emerald-400" : ""}>
              WebSocket {boardLive ? "已连接" : "未连接"}
            </span>
            {` （约 2s 推送 CLOB 买一/卖一/中间价）· 列表深度/成交量 自动刷新 15s · 联赛 ${params.leagues.join(" / ")} · 列表按开赛时间（早 → 晚）`}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {enriched.length > 0 ? (
            <>
              <Tabs
                value={listFilter}
                onValueChange={(v) => {
                  if (v === "all" || v === "tradeable") setListFilter(v);
                }}
                className="w-auto shrink-0"
              >
                <TabsList className="h-9">
                  <TabsTrigger value="all" className="gap-1 px-2.5 text-xs sm:text-sm">
                    全部
                    <span className="tabular-nums text-muted-foreground">({allGameCount})</span>
                  </TabsTrigger>
                  <TabsTrigger value="tradeable" className="gap-1 px-2.5 text-xs sm:text-sm">
                    可交易
                    <span className="tabular-nums text-muted-foreground">
                      ({tradeableGameCount})
                    </span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <ToggleGroup
                type="single"
                value={viewMode}
                onValueChange={(v) => {
                  if (v === "table" || v === "card") setViewMode(v);
                }}
                variant="outline"
                size="sm"
                className="shrink-0"
              >
                <ToggleGroupItem value="table" aria-label="表格视图" className="gap-1 px-2.5">
                  <Table2 className="size-3.5" />
                  表格
                </ToggleGroupItem>
                <ToggleGroupItem value="card" aria-label="卡片视图" className="gap-1 px-2.5">
                  <LayoutGrid className="size-3.5" />
                  卡片
                </ToggleGroupItem>
              </ToggleGroup>
            </>
          ) : null}
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            刷新
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && enriched.length === 0 ? (
        <div className="flex h-40 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 拉取 Polymarket 行情中…
        </div>
      ) : enriched.length === 0 || !hasAnyGames ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无篮球赛事行情。请稍后刷新，或在「全局参数」中检查联赛设置。
        </div>
      ) : (
        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-[color:var(--surface-2)] px-4 py-2.5">
            <span className="text-sm text-muted-foreground">赛事列表</span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={batchBusy || closeBusy || !!pendingMarketId || markets.length === 0}
                onClick={clearAllAmounts}
              >
                一键清空
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={batchBusy || closeBusy || !!pendingMarketId || markets.length === 0}
                onClick={fillAllByRules}
              >
                一键填充
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                共 {filteredGameRows.length} 场
                {listFilter === "tradeable" ? (
                  <span className="ml-1 text-[11px] opacity-80">（热门价≤90¢）</span>
                ) : null}
              </span>
            </div>
          </div>
          {!hasDisplayRows ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              当前「可交易」筛选下暂无赛事（热门侧现价需 ≤ 90¢）。
            </div>
          ) : viewMode === "table" ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[200px]">赛事</TableHead>
                    <TableHead className="min-w-[72px]">名称</TableHead>
                    <TableHead className="text-right">开盘</TableHead>
                    <TableHead className="text-right">现价</TableHead>
                    <TableHead className="text-right">价差</TableHead>
                    <TableHead className="text-right">深度</TableHead>
                    <TableHead className="text-right">24h 量</TableHead>
                    <TableHead className="text-right">建议金额</TableHead>
                    <TableHead className="text-right">止损 %</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredGameRows.map((row: GameRow) => {
                    const { legs, favorite: eventRef } = row;
                    const legsOrdered = orderLegsForDisplay(legs);
                    return (
                      <Fragment key={row.key}>
                        {legsOrdered.map((m, legIdx) => {
                          const held = heldIds.has(m.id);
                          const spreadOk = m.spread <= effParams.maxSpread;
                          const depthOk = passesDepthCheck(m, effParams);
                          const amount = m.customAmount ?? m.suggestedAmount;
                          const tierMeta = m.tier
                            ? params.tiers.find((t) => t.id === m.tier)
                            : undefined;
                          const stopLoss = LOCK_CROSS_MARKET_UI_PARAMS
                            ? (tierMeta?.defaultStopLoss ?? LOCKED_DEFAULT_STOP_LOSS_PCT)
                            : (m.customStopLoss ??
                              tierMeta?.defaultStopLoss ??
                              params.externalDefaultStopLossPct);
                          return (
                            <TableRow
                              key={m.id}
                              className={cn(
                                legIdx > 0 &&
                                  "border-t border-dashed border-primary/25 bg-muted/30",
                              )}
                            >
                              {legIdx === 0 ? (
                                <TableCell rowSpan={legsOrdered.length} className="align-top">
                                  <div className="font-medium leading-tight">
                                    <a
                                      href={eventRef.polymarketUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
                                    >
                                      {baseMatchTitle(eventRef)}
                                    </a>
                                  </div>
                                  {eventRef.chineseSubtitle ? (
                                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                                      {eventRef.chineseSubtitle}
                                    </div>
                                  ) : null}
                                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                                    <LiveEventMark
                                      update={sportsLiveBySlug[sportsSlugForWsWatch(eventRef)]}
                                    />
                                    <span>
                                      {eventRef.league} · {formatNBATipOffET(eventRef.startTime)}
                                    </span>
                                  </div>
                                </TableCell>
                              ) : null}
                              <TableCell className="max-w-[120px] font-medium leading-tight">
                                {outcomeShortLabel(m)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {formatPrice(m.openPrice)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatPrice(m.midPrice)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                <span
                                  className={cn(
                                    spreadOk
                                      ? "text-muted-foreground"
                                      : "text-[color:var(--warning)]",
                                  )}
                                >
                                  {formatSpreadWidthCents(m.spread)}
                                </span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                <span
                                  className={cn(
                                    depthOk
                                      ? "text-muted-foreground"
                                      : "text-[color:var(--warning)]",
                                  )}
                                >
                                  {formatUSD(m.askDepth)}
                                </span>
                              </TableCell>
                              <TableCell className="text-right tabular-nums text-muted-foreground">
                                {formatUSD(m.volume24h ?? 0)}
                              </TableCell>
                              <TableCell className="text-right align-middle">
                                <Input
                                  type="number"
                                  step={1}
                                  value={amount}
                                  onChange={(e) =>
                                    patchMarket(m.id, {
                                      customAmount: Math.round(Number(e.target.value) || 0),
                                    })
                                  }
                                  className={suggestedInputClass(m, amount)}
                                />
                              </TableCell>
                              <TableCell className="text-right align-middle">
                                <Input
                                  type="number"
                                  value={stopLoss}
                                  readOnly={LOCK_CROSS_MARKET_UI_PARAMS}
                                  disabled={LOCK_CROSS_MARKET_UI_PARAMS}
                                  onChange={(e) =>
                                    patchMarket(m.id, {
                                      customStopLoss: Number(e.target.value),
                                    })
                                  }
                                  className="h-7 w-16 text-right tabular-nums"
                                />
                              </TableCell>
                              <TableCell className="text-right align-middle">
                                <Button
                                  size="sm"
                                  variant={held ? "secondary" : "default"}
                                  disabled={
                                    held ||
                                    !spreadOk ||
                                    !depthOk ||
                                    amount <= 0 ||
                                    !m.yesTokenId ||
                                    batchBusy ||
                                    closeBusy ||
                                    pendingMarketId === m.id
                                  }
                                  onClick={() => void buyMarket(m)}
                                >
                                  {pendingMarketId === m.id ? "下单中…" : held ? "已持仓" : "买入"}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="grid gap-3 p-4 sm:grid-cols-1 xl:grid-cols-2">
              {filteredGameRows.map((row: GameRow) => {
                const { legs, favorite: eventRef } = row;
                const legsOrdered = orderLegsForDisplay(legs);
                return (
                  <div
                    key={row.key}
                    className="flex flex-col gap-3 rounded-lg border border-border/80 bg-[color:var(--surface-2)]/40 p-4 shadow-sm"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium leading-snug">{baseMatchTitle(eventRef)}</div>
                        {eventRef.chineseSubtitle ? (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {eventRef.chineseSubtitle}
                          </div>
                        ) : null}
                        <div className="mt-2 rounded-md border border-primary/25 bg-primary/5 px-2 py-1.5 text-[11px] leading-snug text-primary">
                          {favoriteTierCaption(eventRef, params.tiers)}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <LiveEventMark
                            update={sportsLiveBySlug[sportsSlugForWsWatch(eventRef)]}
                          />
                          <span>
                            {eventRef.league} · {formatNBATipOffET(eventRef.startTime)}
                          </span>
                        </div>
                      </div>
                      <div className="shrink-0 pt-0.5">
                        <PolymarketLink url={eventRef.polymarketUrl} />
                      </div>
                    </div>
                    {legsOrdered.map((m, legIdx) => {
                      const held = heldIds.has(m.id);
                      const spreadOk = m.spread <= effParams.maxSpread;
                      const depthOk = passesDepthCheck(m, effParams);
                      const amount = m.customAmount ?? m.suggestedAmount;
                      const tierMeta = m.tier
                        ? params.tiers.find((t) => t.id === m.tier)
                        : undefined;
                      const stopLoss = LOCK_CROSS_MARKET_UI_PARAMS
                        ? (tierMeta?.defaultStopLoss ?? LOCKED_DEFAULT_STOP_LOSS_PCT)
                        : (m.customStopLoss ??
                          tierMeta?.defaultStopLoss ??
                          params.externalDefaultStopLossPct);
                      return (
                        <div
                          key={m.id}
                          className={cn(
                            "space-y-2 text-xs",
                            legIdx > 0 && "border-t border-dashed border-primary/25 pt-3",
                          )}
                        >
                          <div className="text-sm font-medium text-foreground">
                            {outcomeShortLabel(m)}
                          </div>
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            <div>
                              <div className="text-muted-foreground">开盘</div>
                              <div className="tabular-nums font-medium">
                                {formatPrice(m.openPrice)}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">现价</div>
                              <div className="tabular-nums font-medium">
                                {formatPrice(m.midPrice)}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">价差</div>
                              <div
                                className={cn(
                                  "tabular-nums font-medium",
                                  spreadOk
                                    ? "text-muted-foreground"
                                    : "text-[color:var(--warning)]",
                                )}
                              >
                                {formatSpreadWidthCents(m.spread)}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">深度</div>
                              <div
                                className={cn(
                                  "tabular-nums font-medium",
                                  depthOk ? "text-muted-foreground" : "text-[color:var(--warning)]",
                                )}
                              >
                                {formatUSD(m.askDepth)}
                              </div>
                            </div>
                            <div className="col-span-2 sm:col-span-4">
                              <div className="text-muted-foreground">24h 量</div>
                              <div className="tabular-nums">{formatUSD(m.volume24h ?? 0)}</div>
                            </div>
                          </div>
                          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border/40 pt-2">
                            <div className="flex flex-wrap items-end gap-3">
                              <div className="space-y-1">
                                <div className="text-[11px] text-muted-foreground">建议金额</div>
                                <Input
                                  type="number"
                                  value={amount}
                                  onChange={(e) =>
                                    patchMarket(m.id, {
                                      customAmount: Number(e.target.value),
                                    })
                                  }
                                  className={suggestedInputClass(m, amount, "md")}
                                />
                              </div>
                              <div className="space-y-1">
                                <div className="text-[11px] text-muted-foreground">止损 %</div>
                                <Input
                                  type="number"
                                  value={stopLoss}
                                  readOnly={LOCK_CROSS_MARKET_UI_PARAMS}
                                  disabled={LOCK_CROSS_MARKET_UI_PARAMS}
                                  onChange={(e) =>
                                    patchMarket(m.id, {
                                      customStopLoss: Number(e.target.value),
                                    })
                                  }
                                  className="h-8 w-20 text-right tabular-nums"
                                />
                              </div>
                            </div>
                            <Button
                              size="sm"
                              className="min-w-[72px]"
                              variant={held ? "secondary" : "default"}
                              disabled={
                                held ||
                                !spreadOk ||
                                !depthOk ||
                                amount <= 0 ||
                                !m.yesTokenId ||
                                batchBusy ||
                                closeBusy ||
                                pendingMarketId === m.id
                              }
                              onClick={() => void buyMarket(m)}
                            >
                              {pendingMarketId === m.id ? "下单中…" : held ? "已持仓" : "买入"}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      <div className="sticky bottom-0 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-muted-foreground">总拟投入：</span>
            <span className="font-semibold tabular-nums">{formatUSD(totalPlanned)}</span>
            <span className="ml-4 text-muted-foreground">可用：</span>
            <span className="font-semibold tabular-nums">{formatUSD(wallet.usdcBalance)}</span>
          </div>
          <div className="flex gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  disabled={!hasDisplayRows || batchBusy || closeBusy || !!pendingMarketId}
                >
                  <ShoppingCart className="size-4" /> 一键批量买入
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认批量买入？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将向 Polymarket CLOB 提交市价买单，并同步登记到后端监控。仅对「建议金额」不为 0
                    且通过价差/深度校验的盘口下单。当前拟投入合计约 {formatUSD(totalPlanned)}
                    （含手动填写金额）。需已在侧栏配置交易账户。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => {
                      e.preventDefault();
                      void buyAll();
                    }}
                  >
                    {batchBusy ? "提交中…" : "确认买入"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={closeBusy || batchBusy || !!pendingMarketId}
                >
                  <XCircle className="size-4" /> 一键全平
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>确认全部平仓？</AlertDialogTitle>
                  <AlertDialogDescription>
                    将撤销挂单并按市价卖出当前列表中的持仓（与后端已登记仓位一致）。此操作无法撤销。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>取消</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={(e) => {
                      e.preventDefault();
                      void handleCloseAll();
                    }}
                  >
                    {closeBusy ? "提交中…" : "全部卖出"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </div>
  );
}
