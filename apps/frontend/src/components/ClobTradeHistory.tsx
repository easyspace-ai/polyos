import { useMemo, useState } from "react";
import { Download, LayoutGrid, List, Minus, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatProbPriceCents, formatUSD } from "@/lib/calc";
import { cn } from "@/lib/utils";
import type { Market } from "@/lib/types";
import {
  downloadTextFile,
  filterTrades,
  filterTradesByTimeRange,
  formatTradeDateTime,
  isBytes32ConditionHex,
  marketForClobTrade,
  outcomeLabelForTrade,
  parseNum,
  relativeTimeZh,
  shortDisplayId,
  sortTradesNewestFirst,
  tradeCashflowUsdc,
  tradesToCSV,
  type TradeTimeRange,
} from "@/lib/tradeHistory";
import type { CLOBTradeRow, ClobTokenMarketMeta } from "@/lib/tradingApi";

type SideFilter = "all" | "BUY" | "SELL";

function clobTradePriceDisplay(t: { price?: string }): string {
  const p = parseNum(t.price);
  if (p > 0 && p <= 1) {
    return formatProbPriceCents(p);
  }
  const raw = t.price?.trim();
  return raw && raw.length > 0 ? raw : "—";
}

export interface ClobTradeHistoryProps {
  trades: CLOBTradeRow[];
  error: string | null;
  loading?: boolean;
  markets: Market[];
  /** Gamma-backed titles for tokens not present in `markets` (e.g. settled games). */
  tradeMetaByAsset?: Record<string, ClobTokenMarketMeta>;
  onRefresh: () => void | Promise<void>;
}

function tradeRowTitle(
  m: Market | undefined,
  meta: ClobTokenMarketMeta | undefined,
  t: CLOBTradeRow,
): string {
  if (meta?.eventTitle?.trim()) {
    return meta.eventTitle.trim();
  }
  if (m?.question) {
    return m.question;
  }
  if (meta?.question) {
    return meta.question;
  }
  const rm = t.market != null ? String(t.market).trim() : "";
  if (rm && !isBytes32ConditionHex(rm)) {
    return rm.slice(0, 120);
  }
  if (rm && isBytes32ConditionHex(rm)) {
    return `市场 ${shortDisplayId(rm)}`;
  }
  return "市场";
}

function tradeRowUrl(m: Market | undefined, meta: ClobTokenMarketMeta | undefined): string | null {
  const direct = m?.polymarketUrl?.trim();
  if (direct) {
    return direct;
  }
  const fromMeta = meta?.polymarketUrl?.trim();
  if (fromMeta) {
    return fromMeta;
  }
  if (m?.eventSlug?.trim()) {
    return `https://polymarket.com/event/${m.eventSlug.trim()}`;
  }
  if (meta?.eventSlug?.trim()) {
    return `https://polymarket.com/event/${meta.eventSlug.trim()}`;
  }
  return null;
}

export function ClobTradeHistory({
  trades,
  error,
  loading,
  markets,
  tradeMetaByAsset,
  onRefresh,
}: ClobTradeHistoryProps) {
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<SideFilter>("all");
  const [range, setRange] = useState<TradeTimeRange>("all");
  const [view, setView] = useState<"cards" | "table">("cards");

  const filtered = useMemo(() => {
    const byTime = filterTradesByTimeRange(trades, range);
    const f = filterTrades(byTime, query, side);
    return sortTradesNewestFirst(f);
  }, [trades, query, side, range]);

  const onExport = () => {
    const csv = tradesToCSV(filtered);
    const name = `clob-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    downloadTextFile(name, csv, "text/csv;charset=utf-8");
  };

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm font-medium">历史成交（CLOB）</div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[160px] flex-1 sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索 ID / token / 市场…"
              className="h-8 pl-8 text-xs"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <ToggleGroup
            type="single"
            value={side}
            onValueChange={(v) => v && setSide(v as SideFilter)}
            className="justify-start"
          >
            <ToggleGroupItem value="all" className="h-8 px-2 text-xs">
              方向·全部
            </ToggleGroupItem>
            <ToggleGroupItem value="BUY" className="h-8 px-2 text-xs">
              买入
            </ToggleGroupItem>
            <ToggleGroupItem value="SELL" className="h-8 px-2 text-xs">
              卖出
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            type="single"
            value={range}
            onValueChange={(v) => v && setRange(v as TradeTimeRange)}
            className="justify-start"
          >
            <ToggleGroupItem value="all" className="h-8 px-2 text-xs">
              日期·全部
            </ToggleGroupItem>
            <ToggleGroupItem value="24h" className="h-8 px-2 text-xs">
              24h
            </ToggleGroupItem>
            <ToggleGroupItem value="7d" className="h-8 px-2 text-xs">
              7天
            </ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(v) => v && setView(v as "cards" | "table")}
            className="hidden sm:flex"
          >
            <ToggleGroupItem value="cards" className="h-8 px-2 text-xs" title="卡片">
              <LayoutGrid className="h-3.5 w-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem value="table" className="h-8 px-2 text-xs" title="表格">
              <List className="h-3.5 w-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
          <Button
            size="sm"
            variant="secondary"
            className="h-8 text-xs"
            onClick={() => void onRefresh()}
          >
            {loading ? "刷新中…" : "最新"}
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onExport}>
            <Download className="mr-1 h-3.5 w-3.5" />
            导出
          </Button>
        </div>
      </div>

      {error ? (
        <div className="p-6 text-sm text-destructive">{error}</div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          {trades.length === 0 ? "暂无成交记录。" : "无匹配记录，请调整筛选或搜索。"}
        </div>
      ) : view === "table" ? (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[280px]">市场</TableHead>
                <TableHead className="min-w-[180px]">成交</TableHead>
                <TableHead className="text-right whitespace-nowrap">方向</TableHead>
                <TableHead className="text-right">价格</TableHead>
                <TableHead className="text-right">数量</TableHead>
                <TableHead className="text-right whitespace-nowrap">时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((t, i) => {
                const asset = t.asset_id?.trim();
                const m = marketForClobTrade(markets, t);
                const meta = asset && tradeMetaByAsset ? tradeMetaByAsset[asset] : undefined;
                const title = tradeRowTitle(m, meta, t);
                const url = tradeRowUrl(m, meta);
                return (
                  <TableRow key={t.id || String(i)}>
                    <TableCell className="max-w-[360px]">
                      <div className="min-w-0">
                        {url ? (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="line-clamp-2 text-sm font-medium text-primary hover:underline"
                            title="打开 Polymarket 官网"
                          >
                            {title}
                          </a>
                        ) : (
                          <div className="line-clamp-2 text-sm font-medium">{title}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[280px] font-mono text-xs leading-snug break-all">
                      {t.id ?? "—"}
                    </TableCell>
                    <TableCell className="text-right text-sm font-medium">
                      {(t.side || "—").toUpperCase()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {clobTradePriceDisplay(t)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {t.size ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="text-[11px] text-muted-foreground">{relativeTimeZh(t)}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatTradeDateTime(t)}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <ul className="divide-y">
          {filtered.map((t, i) => {
            const asset = t.asset_id?.trim();
            const m = marketForClobTrade(markets, t);
            const meta = asset && tradeMetaByAsset ? tradeMetaByAsset[asset] : undefined;
            const title = tradeRowTitle(m, meta, t);
            const url = tradeRowUrl(m, meta);
            let out = outcomeLabelForTrade(m, asset);
            if (!out && meta?.outcome?.trim()) {
              out = meta.outcome.trim();
            }
            const px = parseNum(t.price);
            const sz = parseNum(t.size);
            const cents = px > 0 && px <= 1 ? formatProbPriceCents(px) : clobTradePriceDisplay(t);
            const sideU = (t.side || "").toUpperCase();
            const isBuy = sideU === "BUY";
            const flow = tradeCashflowUsdc(t);
            const shareStr = sz >= 10 ? `${sz.toFixed(1)} 份额` : `${sz.toFixed(2)} 份额`;

            return (
              <li key={t.id || String(i)} className="flex gap-3 px-4 py-3 sm:gap-4">
                <div className="flex w-24 shrink-0 flex-col items-center gap-1 pt-0.5">
                  <div
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-full border text-xs font-semibold",
                      isBuy
                        ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-200"
                        : "border-muted-foreground/30 bg-muted text-muted-foreground",
                    )}
                  >
                    {isBuy ? <Plus className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                  </div>
                  <span className="text-center text-[11px] font-medium text-muted-foreground">
                    {isBuy ? "买入" : "卖出"}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-sm">
                      🏀
                    </span>
                    <div className="min-w-0">
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="line-clamp-2 font-medium leading-snug text-primary hover:underline"
                          title="打开 Polymarket 官网"
                        >
                          {title}
                        </a>
                      ) : (
                        <div className="line-clamp-2 font-medium leading-snug">{title}</div>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        {out ? (
                          <span className="rounded-md bg-amber-500/12 px-2 py-0 font-medium text-amber-950 dark:text-amber-100">
                            {out} {cents} {shareStr}
                          </span>
                        ) : (
                          <span>
                            {cents} · {shareStr}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      flow >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-foreground",
                    )}
                  >
                    {flow >= 0 ? "+" : ""}
                    {formatUSD(flow)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {relativeTimeZh(t)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{formatTradeDateTime(t)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
