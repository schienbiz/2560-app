/**
 * Strong-death evaluation orchestration — deep-history fetching for the
 * 5-factor 強確認死叉 scoring in engine/strong-death.ts.
 *
 * Vegas EMA169 needs deep, CONVERGED history: with only ~250 bars the EMA seed
 * still carries ~38% of the value and the factor differs materially from the
 * fully-converged EMA the backtest measured. DEEP_DAYS=730 maps to Yahoo's
 * "2y" range (~500 trading bars, seed weight <5%) and Kraken's full 720-bar
 * window; DEEP_MIN_BARS=430 is the sufficiency threshold below which the DB
 * cache is bypassed in favor of a fresh adapter fetch.
 *
 * Fetched lazily, only on the (rare) bar where a death cross actually fires.
 * All series are date-aligned to the cross bar (`asOf`): bars beyond the cross
 * bar are truncated, a symbol series that does not reach the cross bar aborts
 * the evaluation (null), and a market index that lags the cross bar degrades
 * the market factor to 資料不足 instead of silently scoring a stale close.
 *
 * Kept separate from cron/scan.ts so the fetch-fallback and memo logic are
 * unit-testable without scan's db/AI/notify dependency graph.
 */

import { getAdapter } from "../adapters/index.js"
import { getCachedOHLCV, upsertOHLCV } from "../cache.js"
import { scoreStrongDeath } from "../engine/index.js"
import type { StrongDeathResult } from "../engine/index.js"
import type { OHLCV, AssetType } from "../engine/types.js"

export type MarketBucket = "tw" | "us" | "crypto"

export const DEEP_DAYS       = 730   // calendar days: Yahoo "2y" ≈ 500 trading bars; Kraken 720 daily bars
export const DEEP_MIN_BARS   = 430   // below this the DB cache window is considered insufficient
export const MARKET_MIN_BARS = 200   // MA200 applicability gate for the market factor

/** Market index whose MA200 defines the regime factor for a bucket. */
export function marketIndexSymbol(market: MarketBucket): { symbol: string; assetType: AssetType } {
  if (market === "crypto") return { symbol: "BTCUSDT", assetType: "crypto" }
  if (market === "tw")     return { symbol: "0050.TW", assetType: "stock" }
  return { symbol: "SPY", assetType: "stock" }
}

/**
 * Fetch deep history for a symbol, straight from the DB cache + adapter.
 *
 * Deliberately does NOT go through getOrFetchOHLCV: its in-process memory
 * cache both poisons and gets poisoned here — getCachedOHLCV serves any
 * ≥60-row window regardless of requested depth, so a symbol whose DB cache
 * holds only the scan's shallow 90-day fetch would "satisfy" the deep request
 * with 90 bars, get memorized under the deep key until the next stock TTL,
 * and the Vegas/market factors would silently never compute. Reading the DB
 * cache directly and falling back to the adapter keeps the shallow and deep
 * paths independent; _deepMemo below provides the in-process caching.
 *
 * The DB cache is only sufficient when it is BOTH deep enough (≥DEEP_MIN_BARS,
 * so the EMA169 the factors see is converged like the backtest's) AND current
 * through the cross bar (`asOf`) — a series cached before today's close would
 * otherwise score the factors on yesterday's bar.
 */
async function fetchDeepBarsUncached(symbol: string, assetType: AssetType, asOf: string): Promise<OHLCV[]> {
  const cached = await getCachedOHLCV(symbol, assetType, DEEP_DAYS).catch(() => null)
  if (cached && cached.length >= DEEP_MIN_BARS && cached[cached.length - 1].date >= asOf) return cached

  const { adapter } = getAdapter(symbol)
  const bars = await adapter.fetchOHLCV(symbol, DEEP_DAYS)
  if (bars.length > 0) await upsertOHLCV(symbol, assetType, bars).catch(() => {})
  return bars
}

// Promise-dedup memo: several death crosses in one scan (or several users
// watching the same symbol) all need the SAME market index series — without
// this memo each evaluation would re-fetch ~500 bars and re-upsert them in
// parallel. Keyed by symbol+asOf (no depth in the key) so a symbol that is
// also the market index (BTC / SPY / 0050) shares one fetch within a scan run.
// Rejected AND empty-resolved promises are evicted (identity-guarded so a late
// settlement can't delete a newer healthy entry) so one transient failure or
// garbage API response isn't cached for 15 minutes.
const _deepMemo = new Map<string, { promise: Promise<OHLCV[]>; expiresAt: number }>()
const MEMO_TTL_MS = 15 * 60 * 1_000

export function fetchDeepBars(symbol: string, assetType: AssetType, asOf: string): Promise<OHLCV[]> {
  const key = `${symbol}:${assetType}:${asOf}`
  const hit = _deepMemo.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.promise
  const promise = fetchDeepBarsUncached(symbol, assetType, asOf)
  _deepMemo.set(key, { promise, expiresAt: Date.now() + MEMO_TTL_MS })
  const evict = () => {
    if (_deepMemo.get(key)?.promise === promise) _deepMemo.delete(key)
  }
  promise.then(bars => { if (bars.length === 0) evict() }, evict)
  return promise
}

/** Test hook: clear the memo so unit tests don't leak state between cases. */
export function clearDeepMemo(): void {
  _deepMemo.clear()
}

/** Drop any bars newer than the cross bar so factors are scored AT the cross. */
function closesThrough(bars: OHLCV[], asOf: string): number[] {
  let end = bars.length
  while (end > 0 && bars[end - 1].date > asOf) end--
  const out: number[] = new Array(end)
  for (let i = 0; i < end; i++) out[i] = bars[i].close
  return out
}

/**
 * Evaluate the 5 bearish confirmation factors for a death cross at `asOf`
 * (the cross bar's date, e.g. "2026-07-08").
 * Never throws — any data failure returns null and the plain death-cross
 * notification goes out without the confirmation line.
 */
export async function evaluateStrongDeath(
  symbol: string,
  assetType: AssetType,
  slowPeriod: number,
  market: MarketBucket,
  asOf: string
): Promise<StrongDeathResult | null> {
  try {
    const symbolBars = await fetchDeepBars(symbol, assetType, asOf)
    const closes = closesThrough(symbolBars, asOf)
    // The deep series must include the cross bar itself — factors scored on
    // an older bar would describe a different day than the notification.
    if (closes.length === 0 || symbolBars[closes.length - 1].date !== asOf) return null

    const mkt = marketIndexSymbol(market)
    const mktBars = await fetchDeepBars(mkt.symbol, mkt.assetType, asOf).catch(() => [] as OHLCV[])
    const mktCloses = closesThrough(mktBars, asOf)
    // Index must be current through the cross bar (holiday mismatches, e.g. an
    // HK cross on a TW holiday, degrade to 資料不足 instead of a stale close).
    const mktOk = mktCloses.length >= MARKET_MIN_BARS && mktBars[mktCloses.length - 1].date === asOf
    return scoreStrongDeath(closes, mktOk ? mktCloses : null, slowPeriod)
  } catch (err) {
    console.warn(`  ⚠ strong-death eval failed for ${symbol}:`, err)
    return null
  }
}
