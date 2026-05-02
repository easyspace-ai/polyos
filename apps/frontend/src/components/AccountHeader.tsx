import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "./ThemeToggle";
import { useWalletStore, useParamsStore } from "@/lib/store";
import { formatUSD } from "@/lib/calc";
import {
  BACKEND_BASE,
  type BackendAccountView,
  setDefaultBackendAccount,
  syncWalletFromBackend,
} from "@/lib/polymarket";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function displayAddr(a: BackendAccountView) {
  const raw = (a.proxyWalletAddress || a.eoaAddress || "").trim();
  return raw ? shortAddr(raw) : "—";
}

export function AccountHeader() {
  const wallet = useWalletStore();
  const params = useParamsStore((s) => s.params);

  const [accounts, setAccounts] = useState<BackendAccountView[]>([]);
  const [switching, setSwitching] = useState(false);

  const refreshAccounts = useCallback(async () => {
    const data = await syncWalletFromBackend();
    if (data?.accounts) {
      setAccounts(data.accounts);
    } else {
      toast.error("余额未更新", {
        description: `无法连接 ${BACKEND_BASE}（已保留上次数字）。请确认后端已启动，或在本机 .env.local 里设置 VITE_BACKEND_BASE_URL=你的后端地址后重启 npm run dev。`,
      });
    }
  }, []);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  const dailyPool = wallet.usdcBalance * (params.dailyBudgetPct / 100);
  const cashClass = "font-semibold tabular-nums text-emerald-600 dark:text-emerald-400";

  const alias = wallet.accountLabel?.trim() || "未命名";

  const onPickAccount = async (id: string) => {
    if (id === wallet.accountId || switching) return;
    setSwitching(true);
    try {
      await setDefaultBackendAccount(id);
      await refreshAccounts();
    } finally {
      setSwitching(false);
    }
  };

  const walletTrigger = (
    <div className="text-left">
      <div className="text-muted-foreground">
        钱包 · <span className="font-medium text-foreground">{alias}</span>
      </div>
      <div className="flex items-center gap-0.5 font-mono text-[11px] text-foreground/90">
        {wallet.address ? shortAddr(wallet.address) : "未配置"}
        {accounts.length > 0 && <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden />}
      </div>
    </div>
  );

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Wallet className="size-4" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">PolyHoops</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              篮球交易终端
            </div>
          </div>
        </Link>

        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-4 rounded-lg border bg-card px-3 py-1.5 text-xs sm:flex">
            <div>
              <div className="text-muted-foreground">资产组合</div>
              <div className={cashClass}>{formatUSD(wallet.portfolioValue)}</div>
            </div>
            <div className="h-6 w-px bg-border" />
            <div className="min-w-0">
              <div className="text-muted-foreground">现金</div>
              <div className={cashClass}>{formatUSD(wallet.usdcBalance)}</div>
              {wallet.balanceNote ? (
                <div
                  className={cn(
                    "mt-0.5 max-w-[16rem] truncate text-[10px] leading-tight",
                    /链上|不可用/i.test(wallet.balanceNote)
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground",
                  )}
                  title={wallet.balanceNote}
                >
                  {wallet.balanceNote}
                </div>
              ) : (
                <div className="mt-0.5 text-[10px] text-muted-foreground/80">
                  下单以 Polymarket CLOB 可抵押余额为准（非仅链上钱包余额）
                </div>
              )}
            </div>
            <div className="h-6 w-px bg-border" />
            <div>
              <div className="text-muted-foreground">今日资金池</div>
              <div className="font-semibold tabular-nums text-primary">{formatUSD(dailyPool)}</div>
            </div>
            <div className="h-6 w-px bg-border" />
            <div className="min-w-0">
              {accounts.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={switching}
                      className={cn(
                        "w-full max-w-[11rem] rounded-md px-1 py-0.5 text-left outline-none",
                        "transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                        switching && "pointer-events-none opacity-70",
                      )}
                    >
                      <div className="flex items-start gap-1.5">
                        {switching ? (
                          <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        ) : null}
                        {walletTrigger}
                      </div>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[min(100vw-2rem,20rem)]">
                    {accounts.map((a) => (
                      <DropdownMenuItem
                        key={a.id}
                        className="flex cursor-pointer flex-col items-start gap-0.5 py-2"
                        onSelect={() => {
                          void onPickAccount(a.id);
                        }}
                      >
                        <div className="flex w-full items-center gap-2">
                          <span className="font-medium">{a.label?.trim() || "未命名"}</span>
                          {a.isDefault && (
                            <Check className="ml-auto size-4 shrink-0 text-primary" />
                          )}
                        </div>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {displayAddr(a)}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                walletTrigger
              )}
            </div>
          </div>

          <ThemeToggle />
          <Button
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={() => void refreshAccounts()}
          >
            刷新余额
          </Button>
        </div>
      </div>
    </header>
  );
}
