import type { GlobalParams } from "./types";

/**
 * When true: 「价差上限」「深度倍数」在全局参数里禁用，
 * 前端用下方锁定值参与赛事列表过滤与下单。
 */
export const LOCK_CROSS_MARKET_UI_PARAMS = true;

/** 放宽价差过滤（等价于不再按用户价差上限拦截） */
export const LOCKED_MAX_SPREAD = 1;
/** 0 → 深度校验恒通过 */
export const LOCKED_MIN_DEPTH_MULTIPLIER = 0;

/** 合并锁定后的全局参数（仅影响赛事交易与建议金额，不改变 A/B/C 区间与其它项）。 */
export function effectiveMarketParams(params: GlobalParams): GlobalParams {
  if (!LOCK_CROSS_MARKET_UI_PARAMS) {
    return params;
  }
  return {
    ...params,
    maxSpread: LOCKED_MAX_SPREAD,
    minDepthMultiplier: LOCKED_MIN_DEPTH_MULTIPLIER,
  };
}
