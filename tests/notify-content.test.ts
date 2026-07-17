/**
 * Scheduled-report content regressions.
 *
 * Three production content bugs anchored here:
 *   1. The death-cross notification pasted the golden-cross「進場區…停損」line —
 *      telling the user where to BUY into a SELL signal. crossActionLine now
 *      branches: golden = entry zone, death = rebound-trim resistance.
 *   2. Yahoo raw floats (333.260009765625) went straight into push text.
 *   3. LINE (5000) / Telegram (4096) hard caps: an over-limit push 400s and the
 *      whole message is silently lost — clampMessage degrades to a cut-off
 *      message instead of nothing.
 */

import { describe, it, expect } from "vitest"
import { crossActionLine, fmtPrice } from "../cron/scan.js"
import { clampMessage } from "../cron/notify.js"

describe("crossActionLine", () => {
  it("golden cross keeps the entry zone + stop-loss framing", () => {
    const line = crossActionLine("golden_cross", 25, 60, 100, 95)
    expect(line).toContain("進場區 99–101")
    expect(line).toContain("跌破 95（MA60）停損")
  })

  it("death cross must NOT contain entry/stop-loss buy framing", () => {
    const line = crossActionLine("death_cross", 25, 60, 100, 105)
    expect(line).not.toContain("進場區")
    expect(line).not.toContain("停損")
    expect(line).toContain("出場訊號")
    expect(line).toContain("減碼壓力區")
    expect(line).toContain("99–101")   // same MA band, reframed as resistance
  })

  it("uses the user's custom MA periods in labels", () => {
    expect(crossActionLine("death_cross", 5, 20, 100, 105)).toContain("MA5")
    expect(crossActionLine("golden_cross", 5, 20, 100, 95)).toContain("MA20")
  })
})

describe("fmtPrice", () => {
  it("trims Yahoo raw floats to 2 decimals", () => {
    expect(fmtPrice(333.260009765625)).toBe("333.26")
  })

  it("keeps precision for sub-1 alt-coin prices", () => {
    expect(fmtPrice(0.123456)).toBe("0.123456")
  })

  it("adds thousands separators for large prices", () => {
    expect(fmtPrice(63789.5)).toBe("63,789.5")
  })
})

describe("clampMessage", () => {
  it("passes short messages through untouched", () => {
    expect(clampMessage("hello", 4096)).toBe("hello")
  })

  it("clamps over-limit messages to exactly the limit with ellipsis", () => {
    const long = "x".repeat(5000)
    const out = clampMessage(long, 4096)
    expect(out.length).toBe(4096)
    expect(out.endsWith("…")).toBe(true)
  })

  it("boundary: exactly at the limit is untouched", () => {
    const msg = "x".repeat(4096)
    expect(clampMessage(msg, 4096)).toBe(msg)
  })
})
