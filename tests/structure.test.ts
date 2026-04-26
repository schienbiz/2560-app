import { describe, it, expect } from "vitest"
import { computeStructure } from "../src/engine/structure.js"
import type { OHLCV } from "../src/engine/types.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bar(close: number, high?: number, low?: number): OHLCV {
  const h = high ?? close * 1.01
  const l = low  ?? close * 0.99
  return { date: "2026-01-01", open: close, high: h, low: l, close, volume: 1000 }
}

/** Build a series with distinct bar dates for swing detection */
function series(prices: number[]): OHLCV[] {
  return prices.map((c, i) => ({
    date:   `2026-01-${String(i + 1).padStart(2, "0")}`,
    open:   c,
    high:   c * 1.01,
    low:    c * 0.99,
    close:  c,
    volume: 1000,
  }))
}

/**
 * Uptrend series: 20 bars rising steadily 100→200.
 * MA25 > MA60 and close > MA25 → impulse_up + bullish
 */
function uptrendBars(): OHLCV[] {
  return Array.from({ length: 70 }, (_, i) => {
    const p = 100 + i * 1.5
    return {
      date:   `2026-01-${String(i + 1).padStart(2, "0")}`,
      open:   p,
      high:   p + 1,
      low:    p - 1,
      close:  p,
      volume: 1000,
    }
  })
}

/**
 * Downtrend series: 70 bars falling steadily 200→100.
 * MA25 < MA60 and close < MA25 → impulse_down + bearish
 */
function downtrendBars(): OHLCV[] {
  return Array.from({ length: 70 }, (_, i) => {
    const p = 200 - i * 1.5
    return {
      date:   `2026-01-${String(i + 1).padStart(2, "0")}`,
      open:   p,
      high:   p + 1,
      low:    p - 1,
      close:  p,
      volume: 1000,
    }
  })
}

// ─── computeStructure — edge cases ───────────────────────────────────────────

describe("computeStructure — edge cases", () => {
  it("returns neutral range with empty input", () => {
    const result = computeStructure([], [], [])
    expect(result.phase).toBe("range")
    expect(result.bias).toBe("neutral")
    expect(result.swings).toEqual([])
    expect(result.atr14).toBe(0)
  })

  it("returns neutral range when fewer than 10 bars", () => {
    const bars = series([100, 105, 103, 108, 102, 107, 104, 109, 101])
    const result = computeStructure(bars, Array(9).fill(null), Array(9).fill(null))
    expect(result.phase).toBe("range")
    expect(result.swings).toEqual([])
    expect(result.atr14).toBe(0)
  })

  it("returns range bias when ma25 and ma60 are null", () => {
    const bars = uptrendBars()
    const result = computeStructure(bars, Array(bars.length).fill(null), Array(bars.length).fill(null))
    expect(result.phase).toBe("range")
    expect(result.bias).toBe("neutral")
  })

  it("returns range when MAs are converged within 0.5%", () => {
    const bars = series(Array.from({ length: 30 }, () => 100))
    // MA25 = 100, MA60 = 100.4 → spread = 0.004 < 0.005 → range
    const ma25 = Array(30).fill(100)
    const ma60 = Array(30).fill(100.4)
    const result = computeStructure(bars, ma25, ma60)
    expect(result.phase).toBe("range")
    expect(result.bias).toBe("neutral")
  })
})

// ─── computeStructure — trend phases ─────────────────────────────────────────

describe("computeStructure — trend phase classification", () => {
  it("detects impulse_up when ma25 > ma60 and close >= ma25", () => {
    const bars  = uptrendBars()
    const close = bars[bars.length - 1].close        // ~203.5
    // ma25 below close, ma60 below ma25
    const ma25  = Array(bars.length).fill(close - 2)
    const ma60  = Array(bars.length).fill(close - 10)
    const result = computeStructure(bars, ma25, ma60)
    expect(result.phase).toBe("impulse_up")
    expect(result.bias).toBe("bullish")
  })

  it("detects correction when ma25 > ma60 but close < ma25", () => {
    const bars  = uptrendBars()
    const close = bars[bars.length - 1].close        // ~203.5
    // Price dipped below MA25
    const ma25  = Array(bars.length).fill(close + 5)  // close < ma25
    const ma60  = Array(bars.length).fill(close - 10) // ma25 > ma60 → bullish alignment
    const result = computeStructure(bars, ma25, ma60)
    expect(result.phase).toBe("correction")
    expect(result.bias).toBe("bullish")
  })

  it("detects impulse_down when ma25 < ma60 and close <= ma25", () => {
    const bars  = downtrendBars()
    const close = bars[bars.length - 1].close        // ~100
    const ma25  = Array(bars.length).fill(close + 2)  // close < ma25
    const ma60  = Array(bars.length).fill(close + 10) // ma25 < ma60 → bearish
    const result = computeStructure(bars, ma25, ma60)
    expect(result.phase).toBe("impulse_down")
    expect(result.bias).toBe("bearish")
  })

  it("detects correction (bearish) when ma25 < ma60 but close > ma25", () => {
    const bars  = downtrendBars()
    const close = bars[bars.length - 1].close        // ~100
    const ma25  = Array(bars.length).fill(close - 2)  // close > ma25
    const ma60  = Array(bars.length).fill(close + 10) // ma25 < ma60 → bearish
    const result = computeStructure(bars, ma25, ma60)
    expect(result.phase).toBe("correction")
    expect(result.bias).toBe("bearish")
  })
})

// ─── computeStructure — swing labels ─────────────────────────────────────────

describe("computeStructure — swing labels", () => {
  it("returns at most 6 swings", () => {
    // Create a volatile series with many swings so we get at least 6
    const prices = [
      100, 100, 110, 100, 120, 100, 130, 100, 140, 100, 150, 100, 160, 100, 170, 100,
      100, 100, 110, 100, 120, 100, 130, 100, 140, 100, 150, 100, 160, 100, 170, 100,
      100, 100, 110, 100, 120, 100, 130, 100,
    ]
    const bars = series(prices)
    const ma25 = Array(bars.length).fill(120)
    const ma60 = Array(bars.length).fill(110)
    const result = computeStructure(bars, ma25, ma60)
    expect(result.swings.length).toBeLessThanOrEqual(6)
  })

  it("each swing has a valid label", () => {
    const bars = uptrendBars()
    const ma25 = Array(bars.length).fill(150)
    const ma60 = Array(bars.length).fill(140)
    const result = computeStructure(bars, ma25, ma60)
    const validLabels = new Set(["HH", "HL", "LH", "LL"])
    for (const s of result.swings) {
      expect(validLabels.has(s.label)).toBe(true)
    }
  })

  it("swing kind matches label family — highs get HH or LH, lows get HL or LL", () => {
    const bars = uptrendBars()
    const ma25 = Array(bars.length).fill(150)
    const ma60 = Array(bars.length).fill(140)
    const result = computeStructure(bars, ma25, ma60)
    for (const s of result.swings) {
      if (s.kind === "high") {
        expect(["HH", "LH"]).toContain(s.label)
      } else {
        expect(["HL", "LL"]).toContain(s.label)
      }
    }
  })

  it("uptrend series produces predominantly HH and HL labels", () => {
    const bars = uptrendBars()
    const ma25 = Array(bars.length).fill(150)
    const ma60 = Array(bars.length).fill(140)
    const result = computeStructure(bars, ma25, ma60)
    const bullishLabels = result.swings.filter(s => s.label === "HH" || s.label === "HL").length
    // In a clean uptrend, at least half should be bullish structure
    expect(bullishLabels).toBeGreaterThanOrEqual(result.swings.length / 2)
  })
})

// ─── computeStructure — ATR ───────────────────────────────────────────────────

describe("computeStructure — ATR14", () => {
  it("ATR14 is positive for bars with price movement", () => {
    const bars = uptrendBars()
    const ma25 = Array(bars.length).fill(150)
    const ma60 = Array(bars.length).fill(140)
    const result = computeStructure(bars, ma25, ma60)
    expect(result.atr14).toBeGreaterThan(0)
  })

  it("ATR14 reflects candle range — wider ranges → higher ATR", () => {
    const tightBars = Array.from({ length: 30 }, (_, i) => ({
      date:   `2026-01-${String(i + 1).padStart(2, "0")}`,
      open:   100, high: 101, low: 99, close: 100, volume: 1000,
    }))
    const wideBars = Array.from({ length: 30 }, (_, i) => ({
      date:   `2026-01-${String(i + 1).padStart(2, "0")}`,
      open:   100, high: 110, low: 90, close: 100, volume: 1000,
    }))
    const ma = Array(30).fill(null)
    const tight = computeStructure(tightBars, ma, ma)
    const wide  = computeStructure(wideBars,  ma, ma)
    expect(wide.atr14).toBeGreaterThan(tight.atr14)
  })
})

// ─── computeStructure — MA nulls handled gracefully ──────────────────────────

describe("computeStructure — MA null handling", () => {
  it("uses last non-null MA value when array has leading nulls", () => {
    const bars = uptrendBars()
    // Simulate early bars with null MA (not yet warmed up), final value is meaningful
    const close = bars[bars.length - 1].close
    const ma25  = [...Array(50).fill(null), ...Array(20).fill(close - 2)]
    const ma60  = [...Array(50).fill(null), ...Array(20).fill(close - 10)]
    const result = computeStructure(bars, ma25, ma60)
    // Should still classify correctly using the last non-null value
    expect(result.phase).toBe("impulse_up")
    expect(result.bias).toBe("bullish")
  })

  it("returns range/neutral when all MA values are null", () => {
    const bars = uptrendBars()
    const result = computeStructure(bars, Array(70).fill(null), Array(70).fill(null))
    expect(result.phase).toBe("range")
    expect(result.bias).toBe("neutral")
  })
})
