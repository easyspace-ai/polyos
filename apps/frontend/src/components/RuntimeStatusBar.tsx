import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { fetchRuntimeStatus, wsMonitorURL } from "@/lib/polymarket";

function shortAddr(a: string | null | undefined) {
  if (!a) return "—";
  const t = a.trim();
  if (t.length < 14) return t;
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

export function RuntimeStatusBar() {
  const [st, setSt] = useState<Awaited<ReturnType<typeof fetchRuntimeStatus>> | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const [wsPushOk, setWsPushOk] = useState<boolean | null>(null);
  const runtimePollRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const tick = () => {
      if (runtimePollRef.current) {
        return;
      }
      const p: Promise<void> = fetchRuntimeStatus()
        .then((r) => {
          setSt(r);
          setPollErr(null);
        })
        .catch(() => {
          setSt(null);
          setPollErr("后端不可达");
        })
        .then(() => undefined);
      runtimePollRef.current = p;
      p.finally(() => {
        if (runtimePollRef.current === p) {
          runtimePollRef.current = null;
        }
      });
    };
    tick();
    const id = window.setInterval(tick, 15_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const url = wsMonitorURL();
    if (!url) {
      setWsPushOk(null);
      return;
    }
    let ws: WebSocket | null = null;
    let cancelled = false;
    let reconnectTimer: number | null = null;
    let reconnectDelay = 2_000;
    const connect = () => {
      if (cancelled) return;
      try {
        ws = new WebSocket(url);
      } catch {
        setWsPushOk(false);
        reconnectTimer = window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.8, 30_000);
        return;
      }
      ws.onopen = () => {
        if (!cancelled) {
          reconnectDelay = 2_000;
          setWsPushOk(true);
        }
      };
      ws.onerror = () => {
        if (!cancelled) setWsPushOk(false);
        ws?.close();
      };
      ws.onclose = () => {
        if (!cancelled) setWsPushOk((v) => (v === true ? false : v));
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 1.8, 30_000);
        }
      };
    };
    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    };
  }, []);

  const chainOk = st && !st.lastChainSyncError;
  const priceFresh =
    st?.lastPriceTickAt && Date.now() - new Date(st.lastPriceTickAt).getTime() < 120_000;

  return (
    <div className="border-b bg-muted/30 px-4 py-2 text-xs">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="font-medium text-muted-foreground">系统监测</span>
        {pollErr ? <Badge variant="destructive">{pollErr}</Badge> : null}
        {st ? (
          <>
            <Badge variant={st.monitorWsRunning ? "default" : "secondary"}>
              后端行情 WS {st.monitorWsRunning ? "运行中" : "未启动"}
            </Badge>
            <Badge
              variant={wsPushOk ? "default" : wsPushOk === false ? "destructive" : "secondary"}
            >
              监控推送 WS {wsPushOk === true ? "已连接" : wsPushOk === false ? "断开" : "—"}
            </Badge>
            <Badge variant={chainOk ? "outline" : "destructive"}>
              链同步
              {st.lastChainSyncAt ? ` · ${st.lastChainSyncAt.slice(11, 19)}` : " · 尚无"}
              {st.lastChainSyncError ? ` · ${st.lastChainSyncError.slice(0, 48)}` : ""}
            </Badge>
            <span className="text-muted-foreground">
              Data API user {shortAddr(st.lastDataApiUser)} · 返回 {st.lastChainPositionsCount} 条 ·
              本地开仓 {st.openPositionsCount}
            </span>
            <Badge variant={priceFresh ? "outline" : "secondary"}>
              最近行情 tick {st.lastPriceTickAt ? st.lastPriceTickAt.slice(11, 19) : "—"}
            </Badge>
          </>
        ) : !pollErr ? (
          <span className="text-muted-foreground">加载运行状态…</span>
        ) : null}
      </div>
    </div>
  );
}
