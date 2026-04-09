import { describe, it, expect } from "vitest"
import { detectCross, scoreSignal, analyzeSymbol } from "../src/engine/signal.js"
import { computeMA } from "../src/engine/ma.js"
import type { OHLCV } from "../src/engine/types.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bar(close: number, volume = 1000): OHLCV {
  return { date: "2026-01-01", open: close, high: close, low: close, close, volume }
}

/**
 * 80-bar series where the golden cross lands exactly on bar 79 (the last bar).
 *
 * Verified:
 *   bar78: MA25=94.40  MA60=94.67  → MA25 < MA60 ✓
 *   bar79: MA25=96.00  MA60=95.00  → MA25 > MA60 ✓  GOLDEN CROSS
 *
 * findRecentSignal(lookback=5) checks bars 75–79 and finds it at 79.
 */
function goldenCrossRecent(): OHLCV[] {
  return [
    ...Array(45).fill(null).map(() => bar(100)),         // bars  0–44: stable
    ...Array(25).fill(null).map(() => bar(80)),           // bars 45–69: dip
    bar(120, 2500),                                       // bar  70: recovery, vol spike
    ...Array(9).fill(null).map(() => bar(120)),           // bars 71–79: flat at 120
  ]  // 80 bars total, cross at bar 79
}

// ─── detectCross ─────────────────────────────────────────────────────────────

describe("detectCross", () => {
  it("detects golden cross: MA25 crosses above MA60", () => {
    const ma25 = [null, 99, 101] as (number | null)[]
    const ma60 = [null, 100, 100] as (number | null)[]
    expect(detectCross(ma25, ma60).type).toBe("golden_cross")
  })

  it("detects death cross: MA25 crosses below MA60", () => {
    const ma25 = [null, 101, 99] as (number | null)[]
    const ma60 = [null, 100, 100] as (number | null)[]
    expect(detectCross(ma25, ma60).type).toBe("death_cross")
  })

  it("returns none when MA25 stays below MA60", () => {
    const ma25 = [null, 80, 82] as (number | null)[]
    const ma60 = [null, 100, 100] as (number | null)[]
    expect(detectCross(ma25, ma60).type).toBe("none")
  })

  it("returns none when MA25 stays above MA60", () => {
    const ma25 = [null, 110, 112] as (number | null)[]
    const ma60 = [null, 100, 100] as (number | null)[]
    expect(detectCross(ma25, ma60).type).toBe("none")
  })

  it("returns none with insufficient data", () => {
    expect(detectCross([null, null], [null, null]).type).toBe("none")
  })

  it("returns the index of the cross bar", () => {
    const ma25 = [null, 99, 101] as (number | null)[]
    const ma60 = [null, 100, 100] as (number | null)[]
    expect(detectCross(ma25, ma60).index).toBe(2)
  })
})

// ─── scoreSignal (crafted ohlcv + explicit MA arrays) ────────────────────────

describe("scoreSignal", () => {
  it("rates high confidence when volume spikes and close is near MA60", () => {
    // Craft OHLCV so the cross bar (last) has high volume and close ≈ MA60
    const ohlcv: OHLCV[] = [
      ...Array(10).fill(bar(100, 1000)),
      bar(102, 2000),   // cross bar: close=102, vol=2000 (>1200 avg×1.2)
    ]
    // Explicit MA arrays: cross at bar 10 (the last bar)
    const ma25 = [...Array(10).fill(99), 101] as (number | null)[]
    const ma60 = Array(11).fill(100) as (number | null)[]
    // avg vol of last 10 bars = (9×1000 + 2000)/10 = 1100; 2000 > 1100×1.2=1320 ✓
    // proximity: |102 - 100|/100 = 2% ≤ 15% ✓  → confidence HIGH
    const result = scoreSignal(ohlcv, ma25, ma60)
    expect(result.signal).toBe("golden_cross")
    expect(result.confidence).toBe("high")
  })

  it("rates medium confidence when volume spikes but close is far from MA60", () => {
    const ohlcv: OHLCV[] = [
      ...Array(10).fill(bar(100, 1000)),
      bar(140, 2000),   // close 40% above MA60 → proximity fails
    ]
    const ma25 = [...Array(10).fill(99), 101] as (number | null)[]
    const ma60 = Array(11).fill(100) as (number | null)[]
    const result = scoreSignal(ohlcv, ma25, ma60)
    expect(result.signal).toBe("golden_cross")
    expect(result.confidence).toBe("medium")
  })

  it("returns signal=none on a flat series with no cross", () => {
    const ohlcv = Array(90).fill(bar(100))
    const closes = ohlcv.map((b: OHLCV) => b.close)
    const ma25 = computeMA(closes, 25)
    const ma60 = computeMA(closes, 60)
    expect(scoreSignal(ohlcv, ma25, ma60).signal).toBe("none")
  })
})

// ─── analyzeSymbol ───────────────────────────────────────────────────────────

describe("analyzeSymbol", () => {
  it("detects golden cross within the recent lookback window", () => {
    const ohlcv = goldenCrossRecent()
    const result = analyzeSymbol(ohlcv)
    expect(result.signal).toBe("golden_cross")
    expect(result.ma25).not.toBeNull()
    expect(result.ma60).not.toBeNull()
    expect(result.crossIndex).not.toBeNull()
  })

  it("returns none when the cross is older than the lookback window", () => {
    // 20 flat bars after the cross push it outside lookback=5
    const ohlcv = [...goldenCrossRecent(), ...Array(20).fill(bar(120))]
    const result = analyzeSymbol(ohlcv)
    expect(result.signal).toBe("none")
  })

  it("returns none on insufficient data (fewer than 60 bars)", () => {
    const result = analyzeSymbol(Array(30).fill(bar(100)))
    expect(result.signal).toBe("none")
  })
})
