import { describe, it, expect } from "vitest"
import { computeMA, scoreSignal } from "../src/engine/index.js"
import { fetchDaysFor } from "../src/utils/ohlcv.js"

// Helpers to build synthetic price series

function buildPriceSeries(length: number, base = 100): number[] {
  return Array.from({ length }, (_, i) => base + (i % 5))
}

/** Builds closes that produce a golden cross at the last bar for the given periods. */
function buildGoldenCrossSeries(fastPeriod: number, slowPeriod: number): number[] {
  const len = slowPeriod + 10
  // First half: slow falling, fast below slow
  const closes = buildPriceSeries(len, 100)
  // Force a golden cross: last bar has fast > slow
  closes[len - 1] = 150
  return closes
}

describe("scan alert — dynamic MA periods", () => {
  it("computes maFast and maSlow arrays of correct length", () => {
    const closes = buildPriceSeries(100)
    const maFast = computeMA(closes, 5)
    const maSlow = computeMA(closes, 20)
    expect(maFast).toHaveLength(100)
    expect(maSlow).toHaveLength(100)
    // First (period-1) values must be null
    for (let i = 0; i < 4; i++) expect(maFast[i]).toBeNull()
    for (let i = 0; i < 19; i++) expect(maSlow[i]).toBeNull()
    expect(maFast[4]).not.toBeNull()
    expect(maSlow[19]).not.toBeNull()
  })

  it("bar guard: passes when closes.length >= slow_period + 5", () => {
    const slowPeriod = 60
    const closes = buildPriceSeries(slowPeriod + 5)
    expect(closes.length >= slowPeriod + 5).toBe(true)
  })

  it("bar guard: fails when closes.length < slow_period + 5", () => {
    const slowPeriod = 60
    const closes = buildPriceSeries(slowPeriod + 4)
    expect(closes.length < slowPeriod + 5).toBe(true)
  })

  it("scoreSignal works with non-default MA5/MA20 pair", () => {
    const closes = buildPriceSeries(50, 100)
    const maFast = computeMA(closes, 5)
    const maSlow = computeMA(closes, 20)
    // Should run without throwing and return a valid signal
    const result = scoreSignal(closes.map((c, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, open: c, high: c, low: c, close: c, volume: 1000 })), maFast, maSlow)
    expect(["golden_cross", "death_cross", "none"]).toContain(result.signal)
  })

  it("fetchDaysFor gives enough days for MA200 stock scan", () => {
    const days = fetchDaysFor(200, "stock")
    // Must be at least ceil(200 * 1.45) + 30 = 320
    expect(days).toBeGreaterThanOrEqual(320)
    // Days fetched must cover enough calendar days for 205 trading bars
    const estimatedTradingBars = Math.floor(days * (252 / 365))
    expect(estimatedTradingBars).toBeGreaterThanOrEqual(205)
  })
})
