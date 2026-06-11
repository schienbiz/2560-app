import { getCachedOHLCV, upsertOHLCV } from "../cache.js"
import type { MarketAdapter } from "../adapters/interface.js"
import type { OHLCV, AssetType } from "../engine/types.js"

// 365 calendar days / 252 trading days — converts a trading-day window to a calendar-day fetch window.
export const TRADING_TO_CALENDAR = 365 / 252

// In-process memory cache: eliminates repeated DB queries for hot paths (WS every 10s, scan per-symbol).
// Key = "symbol:assetType:days". TTL mirrors the DB cache policy (15m crypto, next 8am UTC stocks).
const _mem = new Map<string, { data: OHLCV[]; expiresAt: number }>()

function _memKey(symbol: string, assetType: AssetType, days: number): string {
  return `${symbol}:${assetType}:${days}`
}

function _memTTL(assetType: AssetType): number {
  if (assetType === "crypto") return Date.now() + 15 * 60 * 1_000
  const exp = new Date()
  exp.setUTCDate(exp.getUTCDate() + 1)
  exp.setUTCHours(8, 0, 0, 0)
  return exp.getTime()
}

/**
 * Returns `days` calendar days of OHLCV for `symbol`.
 * Read order: in-process memory → DB cache → adapter fetch.
 * Writes back to both DB and memory so subsequent calls are served from memory.
 */
export async function getOrFetchOHLCV(
  symbol: string,
  assetType: AssetType,
  days: number,
  adapter: Pick<MarketAdapter, "fetchOHLCV">
): Promise<OHLCV[]> {
  const key = _memKey(symbol, assetType, days)
  const hit = _mem.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.data

  const cached = await getCachedOHLCV(symbol, assetType, days)
  if (cached) {
    _mem.set(key, { data: cached, expiresAt: _memTTL(assetType) })
    return cached
  }

  const fresh = await adapter.fetchOHLCV(symbol, days)
  await upsertOHLCV(symbol, assetType, fresh).catch(() => {})
  if (fresh.length > 0) _mem.set(key, { data: fresh, expiresAt: _memTTL(assetType) })
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
