/**
 * The in-process series cache must obey the SAME freshness rule as the DB
 * cache it sits in front of.
 *
 * Regression: `_memTTL()` re-implemented the rule and lost a branch. cache.ts
 * gives a bar dated TODAY (still forming) a 30-minute TTL, but the in-process
 * copy had no today-bar case and returned "the next 05:30 UTC" for every stock.
 * Measured on 2026-09-07 at 14:44 UTC that was 885 minutes — so a mid-session
 * snapshot stayed authoritative for the rest of the day, sitting in FRONT of
 * the DB fix written specifically to prevent that.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const getCached = vi.fn()
const upsert    = vi.fn()

vi.mock("../src/cache.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/cache.js")>()
  return {
    ...actual,                                   // keep the REAL isCacheStale
    getCachedOHLCV: (...a: unknown[]) => getCached(...a),
    upsertOHLCV:    (...a: unknown[]) => upsert(...a),
  }
})

import { getOrFetchOHLCV, clearOhlcvMemo } from "../src/utils/ohlcv.js"
import type { OHLCV } from "../src/engine/types.js"

const adapter = (bars: () => OHLCV[]) => ({
  fetchOHLCV: vi.fn(async (): Promise<OHLCV[]> => bars()),
  getSource:  () => "yahoo",
})

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10)
const bar = (date: string, close: number): OHLCV =>
  ({ date, open: close, high: close, low: close, close, volume: 1 })

// 09:00 UTC — after the 05:30 settled-day horizon, so a settled bar memoised
// now is entitled to the long overnight buffer.
const T0 = Date.parse("2026-07-06T09:00:00Z")

describe("getOrFetchOHLCV in-process memo", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    clearOhlcvMemo()
    getCached.mockReset()
    upsert.mockReset()
    getCached.mockResolvedValue(null)     // always fall through to the adapter
    upsert.mockResolvedValue(undefined)
  })
  afterEach(() => vi.useRealTimers())

  it("serves a repeat read from memory instead of re-hitting the source", async () => {
    const a = adapter(() => [bar(ymd(T0), 100)])
    await getOrFetchOHLCV("2330.TW", "stock", 90, a)
    await getOrFetchOHLCV("2330.TW", "stock", 90, a)
    expect(a.fetchOHLCV).toHaveBeenCalledTimes(1)
  })

  it("a TODAY-dated (forming) stock bar expires after 30 minutes, like the DB rule", async () => {
    let close = 100
    const a = adapter(() => [bar(ymd(T0), close)])

    const first = await getOrFetchOHLCV("2330.TW", "stock", 90, a)
    expect(first.at(-1)!.close).toBe(100)

    vi.setSystemTime(T0 + 20 * 60_000)          // 20 min — still inside the TTL
    close = 111
    expect((await getOrFetchOHLCV("2330.TW", "stock", 90, a)).at(-1)!.close).toBe(100)
    expect(a.fetchOHLCV).toHaveBeenCalledTimes(1)

    vi.setSystemTime(T0 + 31 * 60_000)          // past it — must refresh
    const third = await getOrFetchOHLCV("2330.TW", "stock", 90, a)
    expect(a.fetchOHLCV).toHaveBeenCalledTimes(2)
    expect(third.at(-1)!.close).toBe(111)
  })

  it("a SETTLED stock bar still rides the long overnight buffer (no extra fetches)", async () => {
    const a = adapter(() => [bar("2026-07-03", 100)])
    await getOrFetchOHLCV("2330.TW", "stock", 90, a)
    vi.setSystemTime(T0 + 5 * 60 * 60_000)      // +5 h, still before 05:30 UTC tomorrow
    await getOrFetchOHLCV("2330.TW", "stock", 90, a)
    expect(a.fetchOHLCV).toHaveBeenCalledTimes(1)
  })

  it("crypto keeps its 15-minute TTL", async () => {
    const a = adapter(() => [bar("2026-07-05", 100)])
    await getOrFetchOHLCV("BTCUSDT", "crypto", 90, a)
    vi.setSystemTime(T0 + 10 * 60_000)
    await getOrFetchOHLCV("BTCUSDT", "crypto", 90, a)
    expect(a.fetchOHLCV).toHaveBeenCalledTimes(1)
    vi.setSystemTime(T0 + 16 * 60_000)
    await getOrFetchOHLCV("BTCUSDT", "crypto", 90, a)
    expect(a.fetchOHLCV).toHaveBeenCalledTimes(2)
  })

  it("records the feed name in the cache source column, not the asset type", async () => {
    const a = adapter(() => [bar(ymd(T0), 100)])
    await getOrFetchOHLCV("2330.TW", "stock", 90, a)
    expect(upsert).toHaveBeenCalledWith("2330.TW", "yahoo", expect.anything())
  })

  it("an empty adapter response is not memoised as a valid series", async () => {
    const a = adapter(() => [])
    await getOrFetchOHLCV("NOPE", "stock", 90, a)
    await getOrFetchOHLCV("NOPE", "stock", 90, a)
    expect(a.fetchOHLCV).toHaveBeenCalledTimes(2)
  })
})
