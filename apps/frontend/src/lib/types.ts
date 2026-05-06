export type PriceTier = string;

export interface TierConfig {
  id: string;
  label: string;
  min: number;
  max: number;
  allocPct: number; // 该价格区间占当日资金池比例
  defaultStopLoss: number; // 默认止损比例（针对该区间）
}

export interface GlobalParams {
  dailyBudgetPct: number; // 资产中拿出多少比例作为当日资金池
  /** 未命中自定义价格区间时使用的移动止损默认比例（%） */
  externalDefaultStopLossPct: number;
  /** 赛事列表后端抓取超时秒数 */
  homeMarketsTimeoutSec: number;
  /** 后端赛事列表磁盘缓存 TTL（秒），与 Polymarket 全局参数一并保存 */
  homeMarketsCacheTtlSec: number;
  /** 后端用户 WS 连接超时（秒）；网络差或 IPv6 fallback 慢时可调大 */
  userWsConnectTimeoutSec: number;
  /** Data API（持仓同步 / 资产组合）请求超时（秒） */
  dataApiTimeoutSec: number;
  /** 后端行情 WS 连接超时（秒） */
  marketWsConnectTimeoutSec: number;
  /** HTTP/WS 代理地址（如 http://127.0.0.1:15236），留空则直连 */
  proxyUrl: string;
  maxSpread: number; // 最大允许买卖价差
  minDepthMultiplier: number; // 深度需大于建议金额倍数
  tiers: TierConfig[];
  leagues: string[];
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
  league: string;
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
  customStopLoss?: number; // legacy: 曾用于单行覆盖止损，当前按全局计划计算
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
  league: string;
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
