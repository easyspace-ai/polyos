import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { useParamsStore } from "@/lib/store";
import {
  LOCK_CROSS_MARKET_UI_PARAMS,
  LOCKED_MAX_SPREAD,
  LOCKED_MIN_DEPTH_MULTIPLIER,
} from "@/lib/productFlags";
import type { PriceTier } from "@/lib/types";

const QUICK_LEAGUES = ["NBA", "NCAAB", "NHL", "EPL", "MLS", "UCL", "MLB"] as const;

export function SettingsTab() {
  const { params, setParams, reset } = useParamsStore();
  const [leagueInput, setLeagueInput] = useState("");

  const updateTier = (id: PriceTier, patch: Partial<(typeof params.tiers)[number]>) => {
    setParams({
      tiers: params.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  };

  const addLeague = (raw: string) => {
    const lg = normalizeLeagueLabel(raw);
    if (!lg || params.leagues.includes(lg)) return;
    setParams({ leagues: [...params.leagues, lg] });
    setLeagueInput("");
  };

  const removeLeague = (lg: string) => {
    if (params.leagues.length <= 1) return;
    setParams({ leagues: params.leagues.filter((x) => x !== lg) });
  };

  const addTier = () => {
    const bounds = nextTierBounds(params.tiers);
    const id = uniqueTierId(
      params.tiers.map((t) => t.id),
      tierId(bounds.min, bounds.max),
    );
    setParams({
      tiers: [
        ...params.tiers,
        {
          id,
          label: tierLabel(bounds.min, bounds.max),
          min: bounds.min / 100,
          max: bounds.max / 100,
          allocPct: 0,
          defaultStopLoss: params.externalDefaultStopLossPct,
        },
      ],
    });
  };

  const removeTier = (id: PriceTier) => {
    if (params.tiers.length <= 1) return;
    setParams({ tiers: params.tiers.filter((t) => t.id !== id) });
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-semibold">资金与风控</h3>
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field
            label="当日资金占比 %"
            value={params.dailyBudgetPct}
            onChange={(v) => setParams({ dailyBudgetPct: Math.min(100, Math.max(1, v)) })}
          />
          <Field
            label="默认止损 %"
            value={params.externalDefaultStopLossPct}
            onChange={(v) =>
              setParams({
                externalDefaultStopLossPct: Math.min(99, Math.max(1, Math.round(v))),
              })
            }
            title="所有未命中价格区间的仓位，统一使用这个回撤比例。"
          />
          <Field
            label="赛事拉取超时（秒）"
            value={params.homeMarketsTimeoutSec}
            onChange={(v) =>
              setParams({
                homeMarketsTimeoutSec: Math.min(120, Math.max(5, Math.round(v))),
              })
            }
            title="后端抓取赛事列表时允许等待的最长时间。网络慢时可适当调大；过大时页面等待也会变长。"
          />
          <Field
            label="赛事列表缓存 TTL（秒）"
            value={params.homeMarketsCacheTtlSec}
            onChange={(v) =>
              setParams({
                homeMarketsCacheTtlSec: Math.min(7200, Math.max(30, Math.round(v))),
              })
            }
            title="后端 home/markets 结果在磁盘上的新鲜度窗口；超时或点「刷新」会重新拉 Gamma/ESPN。建议 60–600；过短会增加上游压力。"
          />
          <Field
            label="用户 WS 连接超时（秒）"
            value={params.userWsConnectTimeoutSec}
            onChange={(v) =>
              setParams({
                userWsConnectTimeoutSec: Math.min(60, Math.max(5, Math.round(v))),
              })
            }
            title="后端连接 Polymarket 用户推送 WebSocket 的握手超时。网络差或 IPv6 fallback 慢时可调大（建议 15–30）。"
          />
          <Field
            label="Data API 超时（秒）"
            value={params.dataApiTimeoutSec}
            onChange={(v) =>
              setParams({
                dataApiTimeoutSec: Math.min(120, Math.max(10, Math.round(v))),
              })
            }
            title="后端拉取持仓 / 资产组合的 HTTP 超时。Data API 慢或持仓多时可调大（建议 30–60）。"
          />
          <Field
            label="行情 WS 超时（秒）"
            value={params.marketWsConnectTimeoutSec}
            onChange={(v) =>
              setParams({
                marketWsConnectTimeoutSec: Math.min(60, Math.max(5, Math.round(v))),
              })
            }
            title="后端连接 Polymarket 行情推送 WebSocket 的握手超时。价格不更新时可调大（建议 15–30）。"
          />
          <div>
            <Label className="text-xs text-muted-foreground">代理地址</Label>
            <Input
              type="text"
              value={params.proxyUrl}
              onChange={(e) => setParams({ proxyUrl: e.target.value.trim() })}
              placeholder="如 http://127.0.0.1:15236"
              className="mt-1"
              title="所有 Polymarket HTTP / WebSocket 请求将走此代理；留空则直连。"
            />
          </div>
        </div>
        {LOCK_CROSS_MARKET_UI_PARAMS ? (
          <p className="mt-3 text-xs text-muted-foreground">
            <span>
              「价差上限」「深度倍数」在赛事列表侧由系统固定为 {LOCKED_MAX_SPREAD} /{" "}
              {LOCKED_MIN_DEPTH_MULTIPLIER}，前端不可改；赛事交易不再按这两项过滤。
            </span>
            <span>
              {" "}
              上方「默认止损」会保存到后端：未命中价格区间的仓位统一使用该比例；命中价格区间的仓位使用区间内的默认止损。
            </span>
            <span>
              {" "}
              「赛事拉取超时」同时作用于后端赛事抓取和前端等待时长；「缓存 TTL」保存在服务端全局参数，仅影响赛事列表缓存。
            </span>
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-semibold">赛事分类</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {params.leagues.map((lg) => (
            <div
              key={lg}
              className="inline-flex h-9 items-center gap-1 rounded-md border border-primary/25 bg-primary/10 pl-3 pr-1 text-sm font-medium text-primary"
            >
              <span>{lg}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-primary hover:bg-primary/15"
                onClick={() => removeLeague(lg)}
                disabled={params.leagues.length <= 1}
                title={`删除 ${lg}`}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-[minmax(220px,320px)_auto]">
          <Input
            value={leagueInput}
            onChange={(e) => setLeagueInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLeague(leagueInput);
              }
            }}
            placeholder="输入标签，例如 EPL、Soccer、MLB"
          />
          <Button onClick={() => addLeague(leagueInput)}>
            <Plus />
            添加分类
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {QUICK_LEAGUES.map((lg) => (
            <Button
              key={lg}
              variant={params.leagues.includes(lg) ? "secondary" : "outline"}
              size="sm"
              onClick={() => addLeague(lg)}
              disabled={params.leagues.includes(lg)}
            >
              {lg}
            </Button>
          ))}
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">价格区间</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              按 YES 价格中位数分组，资金按区间占比分配。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addTier}>
            <Plus />
            添加区间
          </Button>
        </div>
        <div className="mt-4 space-y-4">
          {params.tiers.map((t) => (
            <div key={t.id} className="grid grid-cols-2 gap-3 rounded-lg border p-3 md:grid-cols-6">
              <div>
                <Label className="text-xs text-muted-foreground">名称</Label>
                <Input
                  value={t.label}
                  onChange={(e) => updateTier(t.id, { label: e.target.value })}
                  className="mt-1"
                />
              </div>
              <Field
                label="下限（¢）"
                step={1}
                value={Math.round(t.min * 100)}
                onChange={(v) =>
                  updateTier(t.id, { min: Math.round(Math.min(100, Math.max(0, v))) / 100 })
                }
              />
              <Field
                label="上限（¢）"
                step={1}
                value={Math.round(t.max * 100)}
                onChange={(v) =>
                  updateTier(t.id, { max: Math.round(Math.min(100, Math.max(0, v))) / 100 })
                }
              />
              <Field
                label="资金占比 %"
                value={t.allocPct}
                onChange={(v) => updateTier(t.id, { allocPct: v })}
              />
              <Field
                label="默认止损 %"
                value={t.defaultStopLoss}
                onChange={(v) => updateTier(t.id, { defaultStopLoss: v })}
              />
              <div className="flex items-end">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => removeTier(t.id)}
                  disabled={params.tiers.length <= 1}
                  title={`删除 ${t.label}`}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={reset}>
          重置为默认
        </Button>
      </div>
    </div>
  );
}

function normalizeLeagueLabel(value: string) {
  return value.trim().replace(/\s+/g, "-").toUpperCase();
}

function tierId(min: number, max: number) {
  return `${min}-${max}`;
}

function tierLabel(min: number, max: number) {
  return `${min}-${max}¢`;
}

function uniqueTierId(existing: string[], base: string) {
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

function nextTierBounds(tiers: Array<{ max: number }>) {
  const lastMax = tiers.reduce((m, t) => Math.max(m, Math.round(t.max * 100)), 20);
  const min = Math.min(90, Math.max(0, lastMax));
  return { min, max: Math.min(100, min + 10) };
}

function Field({
  label,
  value,
  onChange,
  step = 1,
  disabled,
  title,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value}
        title={title}
        readOnly={disabled}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn("mt-1 tabular-nums", disabled && "cursor-not-allowed opacity-60")}
      />
    </div>
  );
}
