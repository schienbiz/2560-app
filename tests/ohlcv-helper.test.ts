import { describe, it, expect } from "vitest"
import { fetchDaysFor, TRADING_TO_CALENDAR } from "../src/utils/ohlcv.js"

describe("fetchDaysFor", () => {
  it("returns at least 90 days for small slow periods", () => {
    // slow=25 stock: ceil(25*1.45)+30=67 → max(90,67)=90
    expect(fetchDaysFor(25, "stock")).toBe(90)
    // slow=25 crypto: 25+30=55 → max(90,55)=90
    expect(fetchDaysFor(25, "crypto")).toBe(90)
  })

  it("slow_period=60 stock gives 117 days", () => {
    // ceil(60*1.45)+30 = 87+30 = 117
    expect(fetchDaysFor(60, "stock")).toBe(117)
  })

  it("uses calendar-day ratio for stocks", () => {
    const days = fetchDaysFor(200, "stock")
    // ceil(200 * 1.45) + 30 = ceil(290) + 30 = 320
    expect(days).toBe(320)
  })

  it("uses simple addition for crypto (no ratio)", () => {
    const days = fetchDaysFor(200, "crypto")
    // 200 + 30 = 230
    expect(days).toBe(230)
  })

  it("slow_period=100 stock: gives enough calendar days for 100 trading bars", () => {
    const days = fetchDaysFor(100, "stock")
    // ceil(100 * 1.45) + 30 = 145 + 30 = 175
    expect(days).toBe(175)
    // 175 calendar days × (252/365) ≈ 121 trading days ≥ 105 (slow+5) ✓
    const tradingBars = Math.floor(days * (252 / 365))
    expect(tradingBars).toBeGreaterThanOrEqual(100 + 5)
  })

  it("TRADING_TO_CALENDAR constant is approximately 1.45", () => {
    expect(TRADING_TO_CALENDAR).toBeCloseTo(365 / 252, 5)
  })
})
