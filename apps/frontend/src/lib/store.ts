import { create } from "zustand";
import type { GlobalParams, Market, Position, WalletState } from "./types";
import { DEFAULT_PARAMS } from "./defaults";
import { saveGlobalParams } from "./tradingApi";

interface ParamsStore {
  params: GlobalParams;
  /** True after GET /api/settings/global-params (or error-path fallback) — avoids home/markets using defaults before persisted leagues apply. */
  globalParamsHydrated: boolean;
  setParams: (p: Partial<GlobalParams>) => void;
  reset: () => void;
}

let saveDebounce: ReturnType<typeof setTimeout> | null = null;

function schedulePersistGlobalParams() {
  if (saveDebounce != null) {
    clearTimeout(saveDebounce);
  }
  saveDebounce = setTimeout(() => {
    saveDebounce = null;
    const p = useParamsStore.getState().params;
    void saveGlobalParams(p).catch(() => {
      /* 后端不可用时静默；下次改动会再试 */
    });
  }, 450);
}

export const useParamsStore = create<ParamsStore>((set) => ({
  params: DEFAULT_PARAMS,
  globalParamsHydrated: false,
  setParams: (p) =>
    set((s) => {
      const next = { ...s.params, ...p };
      schedulePersistGlobalParams();
      return { params: next };
    }),
  reset: () => {
    set({ params: DEFAULT_PARAMS, globalParamsHydrated: true });
    void saveGlobalParams(DEFAULT_PARAMS).catch(() => {});
  },
}));

interface WalletStore extends WalletState {
  setWallet: (w: Partial<WalletState>) => void;
  disconnect: () => void;
}

export const useWalletStore = create<WalletStore>((set) => ({
  address: null,
  accountId: null,
  accountLabel: null,
  usdcBalance: 0,
  portfolioValue: 0,
  balanceNote: null,
  setWallet: (w) => set((s) => ({ ...s, ...w })),
  disconnect: () =>
    set({
      address: null,
      accountId: null,
      accountLabel: null,
      usdcBalance: 0,
      portfolioValue: 0,
      balanceNote: null,
    }),
}));

interface MarketStore {
  markets: Market[];
  openPrices: Record<string, number>;
  lastUpdated: number | null;
  loading: boolean;
  error: string | null;
  setMarkets: (m: Market[]) => void;
  patchMarket: (id: string, patch: Partial<Market>) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
}

export const useMarketStore = create<MarketStore>((set) => ({
  markets: [],
  openPrices: {},
  lastUpdated: null,
  loading: false,
  error: null,
  setMarkets: (m) =>
    set((s) => {
      const newOpens = { ...s.openPrices };
      for (const mk of m) {
        if (!(mk.id in newOpens)) newOpens[mk.id] = mk.midPrice;
      }
      return { markets: m, openPrices: newOpens, lastUpdated: Date.now() };
    }),
  patchMarket: (id, patch) =>
    set((s) => ({
      markets: s.markets.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  setLoading: (b) => set({ loading: b }),
  setError: (e) => set({ error: e }),
}));

interface PositionsStore {
  positions: Position[];
  open: (p: Position) => void;
  patch: (marketId: string, patch: Partial<Position>) => void;
  /** Replace list from GET /positions (live hydrate). */
  replaceFromBackend: (list: Position[]) => void;
  closeOne: (marketId: string) => void;
  closeAll: () => void;
}

export const usePositionsStore = create<PositionsStore>((set) => ({
  positions: [],
  open: (p) =>
    set((s) => ({
      positions: s.positions.find((x) => x.marketId === p.marketId)
        ? s.positions
        : [...s.positions, p],
    })),
  replaceFromBackend: (list) => set({ positions: list }),
  patch: (marketId, patch) =>
    set((s) => ({
      positions: s.positions.map((p) => (p.marketId === marketId ? { ...p, ...patch } : p)),
    })),
  closeOne: (marketId) =>
    set((s) => ({
      positions: s.positions.map((p) => (p.marketId === marketId ? { ...p, status: "sold" } : p)),
    })),
  closeAll: () =>
    set((s) => ({
      positions: s.positions.map((p) => (p.status === "bought" ? { ...p, status: "sold" } : p)),
    })),
}));
