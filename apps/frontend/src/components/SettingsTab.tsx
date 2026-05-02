import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useParamsStore } from "@/lib/store";
import { DEFAULT_PARAMS } from "@/lib/defaults";
import {
  LOCK_CROSS_MARKET_UI_PARAMS,
  LOCKED_MAX_SPREAD,
  LOCKED_MIN_DEPTH_MULTIPLIER,
} from "@/lib/productFlags";
import type { PriceTier } from "@/lib/types";

export function SettingsTab() {
  const { params, setParams, reset } = useParamsStore();

  const updateTier = (id: PriceTier, patch: Partial<(typeof params.tiers)[number]>) => {
    setParams({
      tiers: params.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  };

  const toggleLeague = (lg: "NBA" | "NCAAB" | "NHL") => {
    const has = params.leagues.includes(lg);
    const next = has ? params.leagues.filter((x) => x !== lg) : [...params.leagues, lg];
    if (next.length === 0) return;
    setParams({ leagues: next });
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
            label="外链仓位默认止损 %"
            value={params.externalDefaultStopLossPct}
            onChange={(v) =>
              setParams({
                externalDefaultStopLossPct: Math.min(99, Math.max(1, Math.round(v))),
              })
            }
            title="在 Polymarket 官网或其它渠道成交、由链上同步进本系统的仓位，启用移动止损时的默认回撤比例（写入后端 global-params 与风控默认 trail）"
          />
        </div>
        {LOCK_CROSS_MARKET_UI_PARAMS ? (
          <p className="mt-3 text-xs text-muted-foreground">
            <span>
              「价差上限」「深度倍数」在赛事列表侧由系统固定为 {LOCKED_MAX_SPREAD} /{" "}
              {LOCKED_MIN_DEPTH_MULTIPLIER}，前端不可改；赛事交易不再按这两项过滤。
            </span>
            <span>
              {" "}
              上方「外链仓位默认止损」会保存到后端：链上同步的新仓位用该比例作移动止损；在本系统登记仓位时也会同步为后端风控默认
              trail。
            </span>
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-semibold">联赛</h3>
        <div className="mt-3 flex gap-2">
          {(["NBA", "NHL"] as const).map((lg) => {
            const active = params.leagues.includes(lg);
            return (
              <Button
                key={lg}
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() => toggleLeague(lg)}
              >
                {lg}
              </Button>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5">
        <h3 className="text-sm font-semibold">价格区间</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          按 YES 价格中位数将赛事分入 A/B/C 三个区间，资金按区间占比分配。
        </p>
        <div className="mt-4 space-y-4">
          {params.tiers.map((t) => (
            <div key={t.id} className="grid grid-cols-2 gap-3 rounded-lg border p-3 md:grid-cols-5">
              <div>
                <Label className="text-xs text-muted-foreground">区间</Label>
                <div className="mt-1 font-semibold">
                  {t.id} · {t.label}
                </div>
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
            </div>
          ))}
        </div>
      </section>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={reset}>
          重置为默认
        </Button>
        <Button onClick={() => setParams(DEFAULT_PARAMS)} variant="ghost" className="hidden">
          noop
        </Button>
      </div>
    </div>
  );
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
