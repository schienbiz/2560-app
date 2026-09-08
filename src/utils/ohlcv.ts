import { getCachedOHLCV, upsertOHLCV, isCacheStale } from "../cache.js"
import type { MarketAdapter } from "../adapters/interface.js"
import type { OHLCV, AssetType } from "../engine/types.js"

// 365 calendar days / 252 trading days — converts a trading-day window to a calendar-day fetch window.
export const TRADING_TO_CALENDAR = 365 / 252

/**
 * In-process memory cache in FRONT of the DB cache — it removes a Neon round
 * trip per symbol per scan and per interactive read.
 *
 * Freshness is delegated to `isCacheStale`, the exact predicate the DB layer
 * uses, rather than re-implemented here. It used to be re-implemented, and the
 * copy silently lost a branch: cache.ts gives a bar dated TODAY (still forming)
 * a 30-minute TTL, but this layer's `_memTTL()` had no today-bar case and
 * handed out "the next 05:30 UTC" for every stock. Measured on 2026-09-07 at
 * 14:44 UTC that was **885 minutes**, so an intraday snapshot taken when a
 * chart was opened mid-session stayed authoritative for the rest of the day —
 * in front of the DB fix written specifically to stop that. The bug's blast
 * radius happened to be capped by Render's 15-minute idle spin-down recycling
 * the process; on a long-lived host it would be a live wrong-MA bug.
 *
 * Key = "symbol:assetType:days".
 */
const _mem = new Map<string, { data: OHLCV[]; latestBarDate: Date; fetchedAt: Date }>()

function _memKey(symbol: string, assetType: AssetType, days: number): string {
  return `${symbol}:${assetType}:${days}`
}

/** Memoise a series along with the two facts `isCacheStale` needs to judge it. */
function _remember(key: string, bars: OHLCV[]): void {
  if (bars.length === 0) return
  _mem.set(key, {
    data:          bars,
    latestBarDate: new Date(bars[bars.length - 1].date),
    fetchedAt:     new Date(),
  })
}

/** Test hook: drop the in-process series cache between cases. */
export function clearOhlcvMemo(): void { _mem.clear() }

/**
 * Returns `days` calendar days of OHLCV for `symbol`.
 * Read order: in-process memory → DB cache → adapter fetch.
 * Writes back to both DB and memory so subsequent calls are served from memory.
 */
export async function getOrFetchOHLCV(
  symbol: string,
  assetType: AssetType,
  days: number,
  adapter: Pick<MarketAdapter, "fetchOHLCV" | "getSource">
): Promise<OHLCV[]> {
  const key = _memKey(symbol, assetType, days)
  const hit = _mem.get(key)
  if (hit && !isCacheStale(hit.latestBarDate, hit.fetchedAt, assetType)) return hit.data

  const cached = await getCachedOHLCV(symbol, assetType, days)
  if (cached) {
    _remember(key, cached)
    return cached
  }

  const fresh = await adapter.fetchOHLCV(symbol, days)
  await upsertOHLCV(symbol, adapter.getSource(), fresh).catch(() => {})
  _remember(key, fresh)
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
