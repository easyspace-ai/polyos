import { useCallback, useEffect, useMemo, useState } from "react";
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
  startMonitorFeed,
  stopMonitorFeed,
  type BackendPaperPosition,
  type MonitorSnapshotPositionRow,
  type PaperResolveResponse,
} from "@/lib/polymarket";
import { patchRiskConfig, placeMarketBuy, registerBackendPosition } from "@/lib/tradingApi";

function parseNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function LiveRiskTestTab() {
  const [url, setUrl] = useState("https://polymarket.com/event/btc-updown-15m-1776703500");
  const [resolved, setResolved] = useState<PaperResolveResponse | null>(null);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pick, setPick] = useState<{ marketId: string; tokenId: string } | null>(null);
  const [usdc, setUsdc] = useState("25");
  const [trailPct, setTrailPct] = useState("10");
  const [manualShares, setManualShares] = useState("");
  const [manualEntry, setManualEntry] = useState("");
  const [armOnBuy, setArmOnBuy] = useState(true);

  const [lastPos, setLastPos] = useState<BackendPaperPosition | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [snap, setSnap] = useState<MonitorSnapshotPositionRow[]>([]);
  const [snapErr, setSnapErr] = useState<string | null>(null);
  const [feedErr, setFeedErr] = useState<string | null>(null);

  const selectedOutcomeLabel = useMemo(() => {
    if (!resolved || !pick) return "";
    const mk = resolved.markets.find((m) => m.marketId === pick.marketId);
    const tok = mk?.outcomes.find((o) => o.tokenId === pick.tokenId);
    return tok?.outcome?.trim() || "";
  }, [resolved, pick]);

  const ensureRiskConfig = async () => {
    const trail = Number(trailPct);
    if (!Number.isFinite(trail) || trail <= 0 || trail >= 100) {
      throw new Error("止损百分比需在 0–100 之间（不含 0 与 100）");
    }
    await patchRiskConfig({
      defaultStopTrailPct: trail / 100,
    });
    return { trail: trail / 100 };
  };

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

  const onManualRegister = async () => {
    setErr(null);
    if (!resolved || !pick) {
      setErr("请先解析事件并选择一个 outcome");
      return;
    }
    const shares = Number(manualShares);
    const entry = Number(manualEntry);
    if (!Number.isFinite(shares) || shares <= 0) {
      setErr("手动持仓份额无效");
      return;
    }
    if (!Number.isFinite(entry) || entry <= 0 || entry >= 1) {
      setErr("入场价格无效（应在 0~1 之间）");
      return;
    }
    setBusy(true);
    try {
      const { trail } = await ensureRiskConfig();
      const p = await registerBackendPosition({
        marketId: pick.marketId,
        eventId: resolved.eventId,
        tokenId: pick.tokenId,
        shares,
        avgEntryPrice: entry,
        costUsdc: shares * entry,
        stopTrailPct: trail,
        outcomeLabel: selectedOutcomeLabel,
        paper: false,
      });
      const out = armOnBuy ? await armPosition(p.id) : p;
      setLastPos(out);
      await startMonitorFeed();
      await refreshSnap();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onLiveBuyAndRegister = async () => {
    setErr(null);
    if (!resolved || !pick) {
      setErr("请先解析事件并选择一个 outcome");
      return;
    }
    const u = Number(usdc);
    if (!Number.isFinite(u) || u <= 0) {
      setErr("USDC 金额无效");
      return;
    }
    setBusy(true);
    try {
      const { trail } = await ensureRiskConfig();
      const order = await placeMarketBuy({
        tokenId: pick.tokenId,
        amountUsdc: u,
        dryRun: false,
      });
      const px = parseNum(order.price);
      const sharesByOrder = parseNum(order.original_size) || parseNum(order.size_matched);
      const entry = px > 0 ? px : 0;
      const shares = sharesByOrder > 0 ? sharesByOrder : entry > 0 ? u / entry : 0;
      if (!(entry > 0) || !(shares > 0)) {
        throw new Error("下单成功，但未拿到可用成交价/份额，请改用“手动买入后登记监控”");
      }
      const p = await registerBackendPosition({
        marketId: pick.marketId,
        eventId: resolved.eventId,
        tokenId: pick.tokenId,
        shares,
        avgEntryPrice: entry,
        costUsdc: shares * entry,
        stopTrailPct: trail,
        outcomeLabel: selectedOutcomeLabel,
        paper: false,
      });
      const out = armOnBuy ? await armPosition(p.id) : p;
      setLastPos(out);
      await startMonitorFeed();
      await refreshSnap();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshSnap = useCallback(async () => {
    try {
      const s = await fetchMonitorSnapshot();
      setSnap(s.positions.filter((p) => !p.paper));
      setSnapErr(null);
    } catch (e) {
      setSnapErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => {
      void refreshSnap();
    }, 10_000);
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
        <h3 className="text-sm font-semibold">解析 Polymarket 事件（实盘）</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          这里用于测试真实持仓的移动止损。你可以先在外部手动买入，再在本页登记监控；也可直接在本页发起真实买单。
        </p>
        <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="live-url">事件 URL</Label>
            <Input
              id="live-url"
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
        <h3 className="text-sm font-semibold">真实交易参数</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          本页会把「移动止损回撤
          %」下发为后端默认止损比例（与全局参数里的默认止损一致语义），用于登记前对齐风控。
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="live-usdc">名义 USDC（页面买入时）</Label>
            <Input
              id="live-usdc"
              value={usdc}
              onChange={(e) => setUsdc(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="live-trail">移动止损回撤 %</Label>
            <Input
              id="live-trail"
              value={trailPct}
              onChange={(e) => setTrailPct(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <Checkbox
              id="live-arm"
              checked={armOnBuy}
              onCheckedChange={(v) => setArmOnBuy(v === true)}
            />
            <Label htmlFor="live-arm" className="cursor-pointer text-sm font-normal">
              登记后立即 armed
            </Label>
          </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold">手动买入后登记监控（推荐）</h3>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="manual-shares">持仓份额（shares）</Label>
            <Input
              id="manual-shares"
              value={manualShares}
              onChange={(e) => setManualShares(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="manual-entry">入场价格（0~1）</Label>
            <Input
              id="manual-entry"
              value={manualEntry}
              onChange={(e) => setManualEntry(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="flex items-end">
            <Button type="button" disabled={busy} onClick={() => void onManualRegister()}>
              登记并开始监控
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold">页面内真实买入并登记（可选）</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          直接下单会发起真实交易；若未回传可用成交价/份额，请改用上面的“手动买入后登记”。
        </p>
        <Button
          type="button"
          className="mt-4"
          disabled={busy}
          onClick={() => void onLiveBuyAndRegister()}
        >
          真实买入并登记
        </Button>
        {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
        {lastPos && (
          <p className="mt-3 text-xs text-muted-foreground">
            已登记持仓 <span className="font-mono text-foreground">{lastPos.id}</span> · shares{" "}
            {lastPos.shares.toFixed(4)} · 入场 {formatPrice(lastPos.avgEntryPrice)} · armed{" "}
            {lastPos.monitoringActive ? "是" : "否"}
          </p>
        )}
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="text-sm font-semibold">行情与快照（实盘持仓）</h3>
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
            实盘持仓（来自快照，每 2s 轮询）
          </div>
          {snap.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              暂无实盘持仓或未触发过快照
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
