import { describe, it, expect } from "vitest"
import { getMarket } from "../cron/scan.js"

// getMarket decides which market index (BTC / SPY / 0050) the strong-death
// regime factor is judged against, so its routing is load-bearing.
describe("getMarket bucket routing", () => {
  it.each([
    ["crypto", "BTCUSDT", "crypto"],
    ["crypto", "SOLUSDT", "crypto"],
    ["stock", "2330", "tw"],        // 4-digit TW shorthand
    ["stock", "0050.TW", "tw"],
    ["stock", "6488.TWO", "tw"],
    ["stock", "0700.HK", "tw"],     // HK trades TW hours → tw bucket
    ["stock", "AAPL", "us"],
    ["stock", "TSLA", "us"],
  ])("(%s, %s) → %s", (assetType, symbol, expected) => {
    expect(getMarket(assetType, symbol)).toBe(expected)
  })
})
