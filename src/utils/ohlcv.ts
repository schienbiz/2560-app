import { getCachedOHLCV, upsertOHLCV } from "../cache.js"
import type { MarketAdapter } from "../adapters/interface.js"
import type { OHLCV, AssetType } from "../engine/types.js"

// 365 calendar days / 252 trading days — converts a trading-day window to a calendar-day fetch window.
export const TRADING_TO_CALENDAR = 365 / 252

/**
 * Returns `days` calendar days of OHLCV for `symbol`, using the DB cache when
 * warm and falling back to the adapter when not. Writes adapter data back to
 * the cache so subsequent calls are fast.
 */
export async function getOrFetchOHLCV(
  symbol: string,
  assetType: AssetType,
  days: number,
  adapter: Pick<MarketAdapter, "fetchOHLCV">
): Promise<OHLCV[]> {
  const cached = await getCachedOHLCV(symbol, assetType, days)
  if (cached) return cached

  const fresh = await adapter.fetchOHLCV(symbol, days)
  await upsertOHLCV(symbol, assetType, fresh).catch(() => {})
  return fresh
}

/**
 * Calendar-day fetch window for a given MA slow period.
 * Stocks trade ~252 days/year; multiply by 1.45 to get calendar days.
 * Crypto trades 365 days/year; no ratio needed.
 * The +30 buffer absorbs weekends, holidays, and early-bar nulls.
 */
export function fetchDaysFor(slowPeriod: number, assetType: AssetType): number {
  const base = assetType === "crypto"
    ? slowPeriod + 30
    : Math.ceil(slowPeriod * TRADING_TO_CALENDAR) + 30
  return Math.max(90, base)
}
