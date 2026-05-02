export type PriceTier = "A" | "B" | "C";

export interface TierConfig {
  id: PriceTier;
  label: string;
  min: number;
  max: number;
  allocPct: number; // 该价格区间占当日资金池比例
  defaultStopLoss: number; // 默认止损比例（针对该区间）
}

export interface GlobalParams {
  dailyBudgetPct: number; // 资产中拿出多少比例作为当日资金池
  /** 官方 / 外部 API 成交、由链上同步进本地的仓位：移动止损默认比例（%） */
  externalDefaultStopLossPct: number;
  maxSpread: number; // 最大允许买卖价差
  minDepthMultiplier: number; // 深度需大于建议金额倍数
  tiers: TierConfig[];
  leagues: ("NBA" | "NCAAB" | "NHL")[];
}

export interface Market {
  id: string;
  /** CLOB condition id (bytes32 hex) for user-channel WS; from backend home markets */
  conditionId?: string;
  /** Polymarket event slug; matches Sports WS `slug` */
  eventSlug?: string;
  /** Gamma event id；用于合并同一场胜负盘两行 */
  eventId?: string;
  question: string; // 赛事描述
  league: "NBA" | "NCAAB" | "NHL";
  startTime: string; // ISO
  yesTokenId?: string;
  noTokenId?: string;
  openPrice: number; // 开盘价（首次拉取记录）
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spread: number;
  bidDepth: number; // USDC
  askDepth: number;
  /** 近 24h 成交量（USDC，来自 Gamma；与深度二选一排序用） */
  volume24h?: number;
  /** Polymarket 赛事页 */
  polymarketUrl?: string;
  /** 中文对阵，如「尼克斯 vs 老鹰」 */
  chineseSubtitle?: string;
  tier: PriceTier | null;
  suggestedAmount: number; // 建议买入金额（USDC）
  customAmount?: number; // 用户覆盖
  customStopLoss?: number; // 用户覆盖止损
}

export type MarketsSortKey = "start" | "open" | "depth" | "volume";
export type MarketsSortDir = "asc" | "desc";

export type PositionStatus = "pending" | "bought" | "stopped" | "sold";

export interface Position {
  /** When synced with backend paper positions */
  paper?: boolean;
  /** Backend `positions` store id (for arm / close / monitor) */
  backendPositionId?: string;
  /** Short outcome label, e.g. team name (shown as「湖人 73¢」) */
  outcomeLabel?: string;
  marketId: string;
  /** CLOB token id for this outcome (Polymarket BUY target) */
  tokenId?: string;
  question: string;
  league: "NBA" | "NCAAB" | "NHL";
  tier: PriceTier;
  side: "YES" | "NO";
  entryPrice: number;
  currentPrice: number;
  highWaterMark: number; // 历史最高价
  amountUSDC: number;
  shares: number;
  stopLossPct: number;
  status: PositionStatus;
  pnl: number;
  pnlPct: number;
  createdAt: number;
}

export interface WalletState {
  /** Display address: Polymarket 代理钱包优先，否则 EOA */
  address: string | null;
  accountId: string | null;
  /** 当前默认账户备注名（后端 label / name） */
  accountLabel: string | null;
  /**
   * 后端返回的「展示用」美元余额：优先为 CLOB 抵押（可下单）；若 CLOB 查询失败会回退为 Polygon 链上 USDC，金额可能与可下单余额不一致。
   */
  usdcBalance: number;
  /** Data API 资产组合估值（美元，与 Polymarket「资产组合」一致） */
  portfolioValue: number;
  /** 后端 balanceNote：说明余额来源（CLOB / 链上回退等），应用层应用其提示用户 */
  balanceNote: string | null;
}
