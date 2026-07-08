import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock the data layer before importing the module under test.
const getCachedOHLCV = vi.fn()
const bulkInsertOHLCV = vi.fn()
const adapterFetch = vi.fn()

vi.mock("../src/cache.js", () => ({
  getCachedOHLCV: (...args: unknown[]) => getCachedOHLCV(...args),
  bulkInsertOHLCV: (...args: unknown[]) => bulkInsertOHLCV(...args),
}))
vi.mock("../src/adapters/index.js", () => ({
  getAdapter: (symbol: string) => ({
    adapter: { fetchOHLCV: (...args: unknown[]) => adapterFetch(symbol, ...args) },
    normalizedSymbol: symbol,
  }),
}))

import {
  marketIndexSymbol, fetchDeepBars, clearDeepMemo, evaluateStrongDeath,
  DEEP_DAYS, DEEP_MIN_BARS, MARKET_MIN_BARS,
} from "../src/utils/strong-death.js"

const EPOCH = Date.UTC(2025, 0, 1)
const dateOf = (i: number) => new Date(EPOCH + i * 86_400_000).toISOString().slice(0, 10)

function bars(n: number, close = 100): { date: string; open: number; high: number; low: number; close: number; volume: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    date: dateOf(i), open: close, high: close, low: close, close, volume: 1000,
  }))
}
// The cross-bar date for an n-bar series built by bars(n)
const asOfFor = (n: number) => dateOf(n - 1)

beforeEach(() => {
  clearDeepMemo()
  getCachedOHLCV.mockReset()
  adapterFetch.mockReset()
  bulkInsertOHLCV.mockReset()
  bulkInsertOHLCV.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── marketIndexSymbol ───────────────────────────────────────────────────────

describe("marketIndexSymbol", () => {
  it("maps each market bucket to its regime index", () => {
    expect(marketIndexSymbol("crypto")).toEqual({ symbol: "BTCUSDT", assetType: "crypto" })
    expect(marketIndexSymbol("tw")).toEqual({ symbol: "0050.TW", assetType: "stock" })
    expect(marketIndexSymbol("us")).toEqual({ symbol: "SPY", assetType: "stock" })
  })
})

// ─── fetchDeepBars ───────────────────────────────────────────────────────────

describe("fetchDeepBars", () => {
  const N = DEEP_MIN_BARS + 20
  const asOf = asOfFor(N)

  it("serves from the DB cache when deep enough AND current — no adapter fetch", async () => {
    getCachedOHLCV.mockResolvedValue(bars(N))
    const out = await fetchDeepBars("ETHUSDT", "crypto", asOf)
    expect(out).toHaveLength(N)
    expect(getCachedOHLCV).toHaveBeenCalledWith("ETHUSDT", "crypto", DEEP_DAYS)
    expect(adapterFetch).not.toHaveBeenCalled()
  })

  it("falls back to the adapter when the DB cache serves a shallow window", async () => {
    // The 90-bar shallow-cache poisoning case: getCachedOHLCV returns any
    // ≥60-row window, which would leave EMA169/MA200 silently uncomputable
    // (and EMA169 unconverged vs the backtest).
    getCachedOHLCV.mockResolvedValue(bars(90))
    adapterFetch.mockResolvedValue(bars(N))
    const out = await fetchDeepBars("ETHUSDT", "crypto", asOf)
    expect(out).toHaveLength(N)
    expect(adapterFetch).toHaveBeenCalledWith("ETHUSDT", "ETHUSDT", DEEP_DAYS)
    expect(bulkInsertOHLCV).toHaveBeenCalledOnce()   // deep bars written back to cache
  })

  it("falls back to the adapter when the DB cache is deep but STALE (missing the cross bar)", async () => {
    // Yesterday's deep fetch is still inside the DB freshness window at the
    // next scan — without the asOf check the factors would be scored on
    // yesterday's closes.
    getCachedOHLCV.mockResolvedValue(bars(N - 1))        // ends one day before asOf
    adapterFetch.mockResolvedValue(bars(N))
    const out = await fetchDeepBars("2330.TW", "stock", asOf)
    expect(out).toHaveLength(N)
    expect(adapterFetch).toHaveBeenCalled()
  })

  it("falls back to the adapter when the DB cache is empty/stale (null)", async () => {
    getCachedOHLCV.mockResolvedValue(null)
    adapterFetch.mockResolvedValue(bars(N))
    const out = await fetchDeepBars("ETHUSDT", "crypto", asOf)
    expect(out).toHaveLength(N)
  })

  it("still returns deep bars when the cache write-back fails", async () => {
    getCachedOHLCV.mockResolvedValue(null)
    adapterFetch.mockResolvedValue(bars(N))
    bulkInsertOHLCV.mockRejectedValueOnce(new Error("db down"))
    const out = await fetchDeepBars("ETHUSDT", "crypto", asOf)
    expect(out).toHaveLength(N)
  })

  it("returns whatever the adapter has when the fallback is also shallow (young symbol)", async () => {
    getCachedOHLCV.mockResolvedValue(null)
    adapterFetch.mockResolvedValue(bars(100))
    const out = await fetchDeepBars("NEWCOIN", "crypto", asOfFor(100))
    expect(out).toHaveLength(100)   // engine nulls the deep factors downstream
  })

  it("memoizes: concurrent callers share one underlying fetch", async () => {
    getCachedOHLCV.mockResolvedValue(bars(N))
    const [a, b] = await Promise.all([
      fetchDeepBars("BTCUSDT", "crypto", asOf),
      fetchDeepBars("BTCUSDT", "crypto", asOf),
    ])
    expect(a).toEqual(b)
    expect(getCachedOHLCV).toHaveBeenCalledTimes(1)
  })

  it("expired memo entry triggers a fresh underlying fetch", async () => {
    vi.useFakeTimers()
    getCachedOHLCV.mockResolvedValue(bars(N))
    await fetchDeepBars("ETHUSDT", "crypto", asOf)
    vi.advanceTimersByTime(16 * 60 * 1_000)     // past the 15-min memo TTL
    await fetchDeepBars("ETHUSDT", "crypto", asOf)
    expect(getCachedOHLCV).toHaveBeenCalledTimes(2)
  })

  it("evicts rejected promises so a transient failure is not cached", async () => {
    getCachedOHLCV.mockResolvedValue(null)
    adapterFetch.mockRejectedValueOnce(new Error("network down"))
    await expect(fetchDeepBars("ETHUSDT", "crypto", asOf)).rejects.toThrow("network down")
    // Second call must retry, not replay the cached rejection
    getCachedOHLCV.mockResolvedValue(bars(N))
    const out = await fetchDeepBars("ETHUSDT", "crypto", asOf)
    expect(out).toHaveLength(N)
  })

  it("evicts empty-resolved promises so a garbage API response is not cached", async () => {
    getCachedOHLCV.mockResolvedValue(null)
    adapterFetch.mockResolvedValueOnce([])      // degraded provider response
    const first = await fetchDeepBars("ETHUSDT", "crypto", asOf)
    expect(first).toHaveLength(0)
    adapterFetch.mockResolvedValue(bars(N))     // provider recovered
    const second = await fetchDeepBars("ETHUSDT", "crypto", asOf)
    expect(second).toHaveLength(N)
  })
})

// ─── evaluateStrongDeath ─────────────────────────────────────────────────────

describe("evaluateStrongDeath", () => {
  const N = DEEP_MIN_BARS + 20
  const asOf = asOfFor(N)

  it("returns a full 5-factor result when symbol and market data are deep and current", async () => {
    getCachedOHLCV.mockImplementation((symbol: string) =>
      Promise.resolve(bars(N, symbol === "BTCUSDT" ? 400 : 100)))
    const r = await evaluateStrongDeath("ETHUSDT", "crypto", 60, "crypto", asOf)
    expect(r).not.toBeNull()
    expect(r!.applicable).toBe(5)   // flat series: every factor computable
  })

  it("shares one fetch when the symbol IS the market index", async () => {
    getCachedOHLCV.mockResolvedValue(bars(N))
    const r = await evaluateStrongDeath("0050.TW", "stock", 60, "tw", asOf)
    expect(r).not.toBeNull()
    expect(getCachedOHLCV).toHaveBeenCalledTimes(1)   // memo shares symbol + index
  })

  it("truncates bars newer than the cross bar so factors are scored AT the cross", async () => {
    // Deep series gained a bar committed after the cross bar mid-scan.
    getCachedOHLCV.mockResolvedValue(bars(N + 1))
    const r = await evaluateStrongDeath("ETHUSDT", "crypto", 60, "crypto", asOf)
    expect(r).not.toBeNull()        // last bar ≤ asOf after truncation, dates align
  })

  it("returns null when the symbol series does not reach the cross bar", async () => {
    // Both cache AND adapter end one day before the cross → scoring would
    // describe yesterday, not the notified cross. Must abort, not degrade.
    getCachedOHLCV.mockResolvedValue(bars(N - 1))
    adapterFetch.mockResolvedValue(bars(N - 1))
    const r = await evaluateStrongDeath("2330.TW", "stock", 60, "tw", asOf)
    expect(r).toBeNull()
  })

  it("degrades to market=null when the index lags the cross bar (holiday mismatch)", async () => {
    getCachedOHLCV.mockImplementation((symbol: string) =>
      Promise.resolve(symbol === "0050.TW" ? bars(N - 1) : bars(N)))
    adapterFetch.mockImplementation((symbol: string) =>
      Promise.resolve(symbol === "0050.TW" ? bars(N - 1) : bars(N)))
    const r = await evaluateStrongDeath("0700.HK", "stock", 60, "tw", asOf)
    expect(r).not.toBeNull()
    expect(r!.factors.market).toBeNull()
    expect(r!.isStrong).toBe(false)
  })

  it("degrades to market=null when the index fetch fails — still returns a result", async () => {
    getCachedOHLCV.mockImplementation((symbol: string) =>
      symbol === "SPY" ? Promise.reject(new Error("db down")) : Promise.resolve(bars(N)))
    adapterFetch.mockImplementation((symbol: string) =>
      symbol === "SPY" ? Promise.reject(new Error("yahoo 500")) : Promise.resolve(bars(N)))
    const r = await evaluateStrongDeath("TSLA", "stock", 60, "us", asOf)
    expect(r).not.toBeNull()
    expect(r!.factors.market).toBeNull()
    expect(r!.applicable).toBe(4)
    expect(r!.isStrong).toBe(false)   // fail-closed without market data
  })

  it("returns null (never throws) when the symbol fetch fails", async () => {
    getCachedOHLCV.mockResolvedValue(null)
    adapterFetch.mockRejectedValue(new Error("kraken down"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const r = await evaluateStrongDeath("ETHUSDT", "crypto", 60, "crypto", asOf)
    expect(r).toBeNull()
    warn.mockRestore()
  })

  it("returns null when the symbol has no data at all", async () => {
    getCachedOHLCV.mockResolvedValue(null)
    adapterFetch.mockResolvedValue([])
    const r = await evaluateStrongDeath("NEWCOIN", "crypto", 60, "crypto", asOf)
    expect(r).toBeNull()
  })
})
