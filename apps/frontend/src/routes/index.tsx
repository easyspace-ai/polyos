import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AccountHeader } from "@/components/AccountHeader";
import { RuntimeStatusBar } from "@/components/RuntimeStatusBar";
import { MarketsTab } from "@/components/MarketsTab";
import { MonitorTab } from "@/components/MonitorTab";
import { SettingsTab } from "@/components/SettingsTab";
import { AccountTab } from "@/components/AccountTab";
import { PaperTestTab } from "@/components/PaperTestTab";
import { LiveRiskTestTab } from "@/components/LiveRiskTestTab";
import { fetchPositions, startMonitorFeed } from "@/lib/polymarket";
import { backendRowToPosition } from "@/lib/positionsSync";
import { DEFAULT_PARAMS, STORAGE_KEY, normalizeGlobalParamsFromServer } from "@/lib/defaults";
import { fetchGlobalParams, patchRiskConfig, saveGlobalParams } from "@/lib/tradingApi";
import { useMarketStore, useParamsStore, usePositionsStore } from "@/lib/store";

export const Route = createFileRoute("/")({
  component: Dashboard,
  head: () => ({
    meta: [
      { title: "PolyHoops · Polymarket 篮球交易终端" },
      {
        name: "description",
        content: "为 Polymarket 篮球赛事打造的自动化交易工作台：行情、风控、批量下单一站式。",
      },
    ],
  }),
});

function Dashboard() {
  const params = useParamsStore((s) => s.params);
  const markets = useMarketStore((s) => s.markets);

  /**
   * 后台拉全局参数必须在首屏之后做：若在 route loader 里 await fetchGlobalParams，
   * 后端未启动或 TCP 挂起时整页会一直空白（Network 里 global-params 长期「待处理」）。
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await fetchGlobalParams();
        if (!cancelled) {
          useParamsStore.setState({ params: p });
        }
      } catch {
        if (cancelled) {
          return;
        }
        let restored = false;
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as { state?: { params?: unknown } };
            const legacyRaw = parsed?.state?.params;
            if (legacyRaw) {
              const legacy = normalizeGlobalParamsFromServer(legacyRaw);
              useParamsStore.setState({ params: legacy });
              await saveGlobalParams(legacy);
              restored = true;
            }
          }
        } catch {
          /* ignore */
        } finally {
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            /* ignore */
          }
        }
        if (!cancelled && !restored) {
          useParamsStore.setState({ params: DEFAULT_PARAMS });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Sync UI 全局参数 → 后端风控默认 trail（小数）；与链上同步外链仓位止损一致。 */
  useEffect(() => {
    const pct = (n: number) => (n > 1 ? n / 100 : n);
    void patchRiskConfig({
      defaultStopTrailPct: pct(params.externalDefaultStopLossPct),
    }).catch(() => {});
  }, [params.externalDefaultStopLossPct]);

  /** 刷新后从后端恢复实盘持仓 + 尝试启动行情订阅。 */
  useEffect(() => {
    void (async () => {
      try {
        const rows = await fetchPositions(false);
        const p = useParamsStore.getState().params;
        const mk = useMarketStore.getState().markets;
        const mapped = rows.filter((r) => !r.paper).map((r) => backendRowToPosition(r, mk, p));
        usePositionsStore.getState().replaceFromBackend(mapped);
        try {
          await startMonitorFeed();
        } catch {
          /* 无仓位或订阅失败 */
        }
      } catch {
        /* 后端不可用 */
      }
    })();
  }, []);

  /** 行情列表首次有数据后，用市场标题再合并一次持仓展示。 */
  useEffect(() => {
    if (markets.length === 0) return;
    void (async () => {
      try {
        const rows = await fetchPositions(false);
        const p = useParamsStore.getState().params;
        const mapped = rows.filter((r) => !r.paper).map((r) => backendRowToPosition(r, markets, p));
        usePositionsStore.getState().replaceFromBackend(mapped);
      } catch {
        /* ignore */
      }
    })();
  }, [markets.length]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AccountHeader />
      <RuntimeStatusBar />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Tabs defaultValue="markets" className="w-full">
          <TabsList className="grid w-full grid-cols-2 gap-1 sm:grid-cols-3 md:w-auto md:inline-grid md:grid-cols-6">
            <TabsTrigger value="markets">赛事交易</TabsTrigger>
            <TabsTrigger value="monitor">实时监控</TabsTrigger>
            {/* <TabsTrigger value="paper">测试</TabsTrigger>
            <TabsTrigger value="live-test">实盘测试</TabsTrigger> */}
            <TabsTrigger value="settings">全局参数</TabsTrigger>
            <TabsTrigger value="account">账户</TabsTrigger>
          </TabsList>

          <TabsContent value="markets" className="mt-6">
            <MarketsTab />
          </TabsContent>
          <TabsContent value="monitor" className="mt-6">
            <MonitorTab />
          </TabsContent>
          <TabsContent value="paper" className="mt-6">
            <PaperTestTab />
          </TabsContent>
          <TabsContent value="live-test" className="mt-6">
            <LiveRiskTestTab />
          </TabsContent>
          <TabsContent value="settings" className="mt-6">
            <SettingsTab />
          </TabsContent>
          <TabsContent value="account" className="mt-6">
            <AccountTab />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
