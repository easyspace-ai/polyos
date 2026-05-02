import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useParamsStore } from "@/lib/store";
import { formatUSD } from "@/lib/calc";
import {
  type BackendAccountView,
  createBackendAccount,
  deleteBackendAccount,
  fetchAccountsList,
  setDefaultBackendAccount,
  syncDerivedProxyAccount,
  syncWalletFromBackend,
} from "@/lib/polymarket";

function shortAddr(a: string) {
  if (a.length < 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function AccountTab() {
  const params = useParamsStore((s) => s.params);
  const [accounts, setAccounts] = useState<BackendAccountView[]>([]);
  const [defaultId, setDefaultId] = useState("");
  const [loading, setLoading] = useState(true);
  const [listErr, setListErr] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [evmPk, setEvmPk] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListErr(null);
    try {
      const data = await fetchAccountsList();
      setAccounts(data.accounts);
      setDefaultId(data.defaultId);
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const defaultAcc =
    accounts.find((a) => a.id === defaultId) ?? accounts.find((a) => a.isDefault) ?? accounts[0];
  const dailyPool = (defaultAcc?.usdcBalance ?? 0) * (params.dailyBudgetPct / 100);

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormErr(null);
    const pk = evmPk.trim();
    if (!pk) {
      setFormErr("请填写 EVM 私钥。");
      return;
    }
    setSubmitting(true);
    try {
      await createBackendAccount({
        label: label.trim(),
        evmPrivateKey: pk.startsWith("0x") ? pk : `0x${pk}`,
      });
      setLabel("");
      setEvmPk("");
      await load();
      await syncWalletFromBackend();
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : "添加失败");
    } finally {
      setSubmitting(false);
    }
  };

  const onSetDefault = async (id: string) => {
    if (id === defaultId) return;
    try {
      await setDefaultBackendAccount(id);
      setDefaultId(id);
      await load();
      await syncWalletFromBackend();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "设置默认失败");
    }
  };

  const onSyncProxy = async (id: string) => {
    setListErr(null);
    setSyncingId(id);
    try {
      await syncDerivedProxyAccount(id);
      await load();
      await syncWalletFromBackend();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "同步代理地址失败");
    } finally {
      setSyncingId(null);
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("确定删除该账号？后端 JSON 中的密钥将一并删除。")) return;
    try {
      await deleteBackendAccount(id);
      await load();
      await syncWalletFromBackend();
    } catch (e) {
      setListErr(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-5">
        <div className="text-sm font-medium">添加账号</div>
        <p className="mt-1 text-xs text-muted-foreground">
          凭证写入后端 <span className="font-mono">data/derived-credentials.json</span>
          （默认路径，由私钥推导代理地址与 CLOB
          API），供本机监控、止损与下单使用。仅在可信局域网使用。
        </p>
        <form onSubmit={onAdd} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="acc-label">备注名（可选）</Label>
              <Input
                id="acc-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="主账户"
                className="mt-1.5"
                autoComplete="off"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="acc-pk">EVM 私钥</Label>
            <Input
              id="acc-pk"
              type="password"
              value={evmPk}
              onChange={(e) => setEvmPk(e.target.value)}
              placeholder="0x…"
              className="mt-1.5 font-mono text-xs"
              autoComplete="off"
            />
          </div>

          {formErr && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {formErr}
            </div>
          )}

          <Button type="submit" disabled={submitting || !evmPk.trim()}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            保存到后端
          </Button>
        </form>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-medium">账号列表</div>
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            刷新
          </Button>
        </div>
        {listErr && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {listErr}
          </div>
        )}
        {loading ? (
          <p className="mt-4 text-sm text-muted-foreground">加载中…</p>
        ) : accounts.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">暂无账号，请在上方添加。</p>
        ) : (
          <RadioGroup
            value={defaultId}
            onValueChange={(v) => void onSetDefault(v)}
            className="mt-4 space-y-3"
          >
            {accounts.map((a) => (
              <div
                key={a.id}
                className="flex flex-col gap-3 rounded-lg border bg-background/50 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <RadioGroupItem value={a.id} id={`def-${a.id}`} className="mt-1" />
                  <label htmlFor={`def-${a.id}`} className="cursor-pointer space-y-1">
                    <div className="text-sm font-medium">{a.label || "未命名"}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      代理/展示：{a.proxyWalletAddress ? shortAddr(a.proxyWalletAddress) : "—"} ·
                      EOA {shortAddr(a.eoaAddress)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      资产组合{" "}
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        {formatUSD(a.portfolioValue ?? 0)}
                      </span>
                      {" · "}现金{" "}
                      <span className="font-medium text-emerald-600 dark:text-emerald-400">
                        {formatUSD(a.usdcBalance)}
                      </span>
                      {a.balanceNote ? ` · ${a.balanceNote}` : ""}
                    </div>
                    {a.hasClobCredentials && (
                      <div className="text-[11px] text-primary">已配置 CLOB</div>
                    )}
                  </label>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 pl-7 sm:pl-0">
                  <span className="text-[11px] text-muted-foreground">默认</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    disabled={syncingId === a.id}
                    title="用私钥重新推导 Polymarket Safe 并写回代理地址（修正 Data API 查不到仓位）"
                    onClick={() => void onSyncProxy(a.id)}
                  >
                    {syncingId === a.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    同步代理
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void onDelete(a.id)}
                    aria-label="删除"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </RadioGroup>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            默认账户 · 今日资金池
          </div>
          <div className="mt-2 text-2xl font-semibold tabular-nums text-primary">
            {formatUSD(dailyPool)}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            按全局参数 {params.dailyBudgetPct}% 从默认账户余额估算
          </div>
        </div>
        <div className="rounded-xl border bg-card p-5 md:col-span-1">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">安全提示</div>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            <li>• 账号与密钥保存在后端 JSON，重启服务后仍保留；请勿把该文件提交到版本库。</li>
            <li>
              • 默认账户的凭证与 .env 合并（JSON
              非空字段优先）；切换默认、添加或删除账号后，后端会立即热更新 CLOB 认证，无需重启。
            </li>
            <li>
              • 列表中的 USDC 优先来自 Polymarket CLOB 抵押余额（与网页一致）；若无 CLOB
              凭证或查询失败，会回退为链上 USDC.e（需配置{" "}
              <span className="font-mono">POLYGON_RPC_URL</span>）。
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
