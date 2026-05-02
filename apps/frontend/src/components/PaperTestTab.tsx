import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPrice, formatUSD } from "@/lib/calc";
import {
  armPosition,
  fetchMonitorSnapshot,
  resolvePaperEvent,
  simulatePaperBuy,
  startMonitorFeed,
  stopMonitorFeed,
  type BackendPaperPosition,
  type MonitorSnapshotPositionRow,
  type PaperResolveResponse,
} from "@/lib/polymarket";

export function PaperTestTab() {
  const [url, setUrl] = useState("https://polymarket.com/event/btc-updown-15m-1776703500");
  const [resolved, setResolved] = useState<PaperResolveResponse | null>(null);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pick, setPick] = useState<{ marketId: string; tokenId: string } | null>(null);
  const [usdc, setUsdc] = useState("25");
  /** 移动止损比例：填 10 表示 10%，即后端 0.1 */
  const [trailPct, setTrailPct] = useState("10");
  const [armOnBuy, setArmOnBuy] = useState(true);

  const [lastPos, setLastPos] = useState<BackendPaperPosition | null>(null);
  const [buyErr, setBuyErr] = useState<string | null>(null);

  const [snap, setSnap] = useState<MonitorSnapshotPositionRow[]>([]);
  const [snapErr, setSnapErr] = useState<string | null>(null);
  const [feedErr, setFeedErr] = useState<string | null>(null);

  const onResolve = async () => {
    setResolveErr(null);
    setBusy(true);
    try {
      const r = await resolvePaperEvent(url.trim());
      setResolved(r);
      setPick(null);
    } catch (e) {
      setResolved(null);
      setResolveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSimulateBuy = async () => {
    setBuyErr(null);
    if (!resolved || !pick) {
      setBuyErr("请先解析事件并选择一个 outcome");
      return;
    }
    const u = Number(usdc);
    const trail = Number(trailPct);
    if (!Number.isFinite(u) || u <= 0) {
      setBuyErr("USDC 金额无效");
      return;
    }
    if (!Number.isFinite(trail) || trail <= 0 || trail >= 100) {
      setBuyErr("止损百分比需在 0–100 之间（不含 0 与 100）");
      return;
    }
    setBusy(true);
    try {
      const pos = await simulatePaperBuy({
        marketId: pick.marketId,
        eventId: resolved.eventId,
        tokenId: pick.tokenId,
        usdc: u,
        stopTrailPct: trail / 100,
        arm: armOnBuy,
      });
      setLastPos(pos);
    } catch (e) {
      setBuyErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshSnap = useCallback(async () => {
    try {
      const s = await fetchMonitorSnapshot();
      setSnap(s.positions.filter((p) => p.paper));
      setSnapErr(null);
    } catch (e) {
      setSnapErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      void refreshSnap();
    }, 2000);
    void refreshSnap();
    return () => window.clearInterval(t);
  }, [refreshSnap]);

  const onStartFeed = async () => {
    setFeedErr(null);
    try {
      await startMonitorFeed();
      await refreshSnap();
    } catch (e) {
      setFeedErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onStopFeed = async () => {
    setFeedErr(null);
    try {
      await stopMonitorFeed();
    } catch (e) {
      setFeedErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-8">
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold">解析 Polymarket 事件</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          支持 <code className="rounded bg-muted px-1">/event/…</code> 与{" "}
          <code className="rounded bg-muted px-1">/sports/…/…</code>（取最后一段为事件 slug）等
          Polymarket 链接，拉取 Gamma 上的 markets 与 CLOB token；纸面卖出为
          dry-run，不会真实下单。纸持仓仅走移动止损。
        </p>
        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="paper-url">事件 URL</Label>
            <Input
              id="paper-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://polymarket.com/event/… 或 /sports/…"
            />
          </div>
          <Button type="button" disabled={busy} onClick={() => void onResolve()}>
            解析
          </Button>
        </div>
        {resolveErr && <p className="mt-2 text-sm text-destructive">{resolveErr}</p>}
        {resolved && (
          <div className="mt-4 space-y-2">
            <div className="text-sm font-medium">{resolved.title}</div>
            <div className="text-xs text-muted-foreground">
              slug: {resolved.slug} · eventId: {resolved.eventId}
            </div>
            <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
              {resolved.markets.map((m) => (
                <div key={m.marketId} className="rounded-lg border bg-background/50 p-3">
                  <div className="text-xs font-medium text-muted-foreground">{m.marketId}</div>
                  <div className="text-sm">{m.question}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.outcomes.map((o) => {
                      const sel = pick?.tokenId === o.tokenId && pick?.marketId === m.marketId;
                      return (
                        <Button
                          key={o.tokenId}
                          type="button"
                          size="sm"
                          variant={sel ? "default" : "outline"}
                          onClick={() => setPick({ marketId: m.marketId, tokenId: o.tokenId })}
                        >
                          {o.outcome || o.tokenId.slice(0, 8)}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold">模拟买入（纸持仓）</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="paper-usdc">名义 USDC</Label>
            <Input
              id="paper-usdc"
              value={usdc}
              onChange={(e) => setUsdc(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="paper-trail">移动止损回撤 %</Label>
            <Input
              id="paper-trail"
              value={trailPct}
              onChange={(e) => setTrailPct(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <Checkbox
              id="paper-arm"
              checked={armOnBuy}
              onCheckedChange={(v) => setArmOnBuy(v === true)}
            />
            <Label htmlFor="paper-arm" className="cursor-pointer text-sm font-normal">
              买入后立即 armed（参与行情风控）
            </Label>
          </div>
        </div>
        <Button type="button" className="mt-4" disabled={busy} onClick={() => void onSimulateBuy()}>
          纸面买入
        </Button>
        {buyErr && <p className="mt-2 text-sm text-destructive">{buyErr}</p>}
        {lastPos && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              已登记持仓 <span className="font-mono text-foreground">{lastPos.id}</span> · shares{" "}
              {lastPos.shares.toFixed(4)} · 入场 {formatPrice(lastPos.avgEntryPrice)} · armed{" "}
              {lastPos.monitoringActive ? "是" : "否"}
            </p>
            {!lastPos.monitoringActive && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  armPosition(lastPos.id)
                    .then((p) => setLastPos(p))
                    .catch((e) => setBuyErr(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false));
                }}
              >
                Arm 该持仓
              </Button>
            )}
          </div>
        )}
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold">行情与快照</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          启动后后端会订阅当前所有 <code className="rounded bg-muted px-1">open</code> 持仓的
          token（含纸持仓）。触发移动止损时纸持仓为{" "}
          <code className="rounded bg-muted px-1">dry-run</code> 卖出。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => void onStartFeed()}>
            启动监控行情
          </Button>
          <Button type="button" variant="outline" onClick={() => void onStopFeed()}>
            停止行情
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void refreshSnap()}>
            刷新快照
          </Button>
        </div>
        {feedErr && <p className="mt-2 text-sm text-destructive">{feedErr}</p>}
        {snapErr && <p className="mt-2 text-sm text-destructive">{snapErr}</p>}

        <div className="mt-6 overflow-hidden rounded-lg border">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
            纸持仓（来自快照，每 2s 轮询）
          </div>
          {snap.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              暂无 paper 持仓或未触发过快照
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>持仓 ID</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">中间价</TableHead>
                  <TableHead className="text-right">最高水位</TableHead>
                  <TableHead className="text-right">浮盈（中间价）</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snap.map((p) => {
                  const mid = p.mid ?? 0;
                  const hwm = p.state === "open" ? Math.max(p.highWaterMark, mid) : p.highWaterMark;
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="max-w-[140px] truncate font-mono text-xs">
                        {p.id}
                      </TableCell>
                      <TableCell className="text-xs">
                        {p.state}
                        {p.monitoringActive ? " · 监控中" : ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatPrice(mid)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPrice(hwm)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUSD(p.unrealizedMidUsdc)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </section>
    </div>
  );
}
