import { describe, it, expect } from "vitest"
import { normalizeKrakenBars, type KrakenOHLCRow } from "../src/adapters/binance.js"

// Kraken returns the in-progress UTC-day candle as the last row and reports the
// last *committed* candle in result.last. normalizeKrakenBars must drop anything
// past lastCommitted so daily crosses fire on settled closes only.

const t = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000)
const row = (d: string, close: number, vol = 100): KrakenOHLCRow =>
  [t(d), "1", "2", "0.5", String(close), "0", String(vol), 0]

describe("normalizeKrakenBars", () => {
  it("drops the in-progress candle (time > lastCommitted)", () => {
    const rows = [row("2026-07-03", 61000), row("2026-07-04", 63000), row("2026-07-05", 62600, 33)]
    const bars = normalizeKrakenBars(rows, t("2026-07-04"), 10)   // 07-04 settled, 07-05 forming
    expect(bars.map(b => b.date)).toEqual(["2026-07-03", "2026-07-04"])
    expect(bars[bars.length - 1].close).toBe(63000)   // last is the settled day, not the forming 62600
  })

  it("keeps the last row when it is exactly the committed candle", () => {
    const rows = [row("2026-07-03", 61000), row("2026-07-04", 63000)]
    const bars = normalizeKrakenBars(rows, t("2026-07-04"), 10)
    expect(bars).toHaveLength(2)
    expect(bars[1].date).toBe("2026-07-04")
  })

  it("keeps all rows when lastCommitted is Infinity (marker missing → fail open)", () => {
    const rows = [row("2026-07-03", 61000), row("2026-07-04", 63000), row("2026-07-05", 62600)]
    expect(normalizeKrakenBars(rows, Infinity, 10)).toHaveLength(3)
  })

  it("trims to the requested days after dropping the forming candle", () => {
    const rows = [row("2026-07-01", 60000), row("2026-07-02", 60500), row("2026-07-03", 61000), row("2026-07-04", 63000), row("2026-07-05", 62600)]
    const bars = normalizeKrakenBars(rows, t("2026-07-04"), 2)   // 4 settled → keep last 2
    expect(bars.map(b => b.date)).toEqual(["2026-07-03", "2026-07-04"])
  })
})
