/**
 * EMA / RSI(14) / MACD(12,26,9).
 *
 * These had no test file, while feeding two of the four confidence factors, two
 * of the five strong-death factors, and the backtest's grading. Expected values
 * are worked out by hand or from an identity that holds analytically, never by
 * recording whatever the code emitted.
 */

import { describe, it, expect } from "vitest"
import { computeEMA, computeRSI, computeMACD } from "../src/engine/indicators.js"

describe("computeEMA", () => {
  it("is null until `period` prices exist, then seeds with the SMA", () => {
    const e = computeEMA([1, 2, 3, 4, 5], 3)
    expect(e.slice(0, 2)).toEqual([null, null])
    expect(e[2]).toBeCloseTo((1 + 2 + 3) / 3, 10)      // seed = SMA
  })

  it("applies k = 2/(period+1) to each later bar", () => {
    // seed = 2, k = 2/4 = 0.5 → next = 4·0.5 + 2·0.5 = 3
    const e = computeEMA([1, 2, 3, 4], 3)
    expect(e[2]).toBeCloseTo(2, 10)
    expect(e[3]).toBeCloseTo(4 * 0.5 + 2 * 0.5, 10)
  })

  it("stays flat on a constant series — the seed already equals every input", () => {
    const e = computeEMA(Array(20).fill(7), 5)
    for (const v of e.slice(4)) expect(v).toBeCloseTo(7, 10)
  })

  it("returns all nulls when there is not even one full period", () => {
    expect(computeEMA([1, 2], 5)).toEqual([null, null])
  })
})

describe("computeRSI", () => {
  it("first value lands at index `period`, not earlier", () => {
    const r = computeRSI([1, 2, 3, 4, 5, 6], 3)
    expect(r.slice(0, 3)).toEqual([null, null, null])
    expect(r[3]).not.toBeNull()
  })

  it("a strictly rising series has no losses → 100", () => {
    const r = computeRSI([1, 2, 3, 4, 5, 6, 7, 8], 3)
    expect(r.at(-1)).toBeCloseTo(100, 10)
  })

  it("a strictly falling series has no gains → 0", () => {
    const r = computeRSI([8, 7, 6, 5, 4, 3, 2, 1], 3)
    expect(r.at(-1)).toBeCloseTo(0, 10)
  })

  /**
   * Mirror symmetry: negate every price change and the two RSIs must sum to
   * exactly 100. With r = avgGain/avgLoss, RSI = 100r/(1+r) and the mirrored
   * series gives 100/(1+r); they add to 100 for any r. An analytic identity, so
   * it holds for any input — and it catches a sign error or asymmetric
   * smoothing that a single hand-picked number would not.
   */
  it("a series and its mirror image sum to 100", () => {
    const closes = [100, 103, 101, 107, 106, 110, 104, 111, 109, 115, 112, 118, 116, 120, 117, 123]
    const mirrored = closes.reduce<number[]>((acc, c, i) =>
      i === 0 ? [c] : [...acc, acc[i - 1] - (c - closes[i - 1])], [])

    const a = computeRSI(closes, 14).at(-1)!
    const b = computeRSI(mirrored, 14).at(-1)!
    expect(a + b).toBeCloseTo(100, 8)
    expect(a).not.toBeCloseTo(50, 1)   // the identity was not satisfied trivially
  })

  it("an alternating series hovers at 50, leaning to whichever way the last bar moved", () => {
    // Wilder smoothing makes avgGain and avgLoss take turns leading, so this
    // sits just off 50 rather than exactly on it.
    const upLast   = Array.from({ length: 60 }, (_, i) => 100 + (i % 2))       // ends on a gain
    const downLast = Array.from({ length: 61 }, (_, i) => 100 + (i % 2))       // ends on a loss
    const up   = computeRSI(upLast, 14).at(-1)!
    const down = computeRSI(downLast, 14).at(-1)!
    expect(up).toBeGreaterThan(50)
    expect(down).toBeLessThan(50)
    expect(Math.abs(up - 50)).toBeLessThan(5)
    expect(Math.abs(down - 50)).toBeLessThan(5)
    // NOT asserted here: that these two sum to 100. They are different lengths,
    // so one is not the mirror of the other and the smoothed averages differ
    // slightly (measured 100.127). The mirror identity is proved above, on an
    // actual mirror.
  })

  /**
   * A FLAT series has avgGain = avgLoss = 0, and the code returns 100 because
   * it short-circuits on `avgLoss === 0`. Conventionally a flat market is 50,
   * or undefined. Pinned rather than changed: 100 makes the RSI confidence
   * factor pass for a halted or untraded symbol, which is wrong but changes
   * live scoring — a product call, not a tidy-up.
   */
  it("a completely flat series returns 100, not 50 — a known wart", () => {
    expect(computeRSI(Array(40).fill(100), 14).at(-1)).toBe(100)
  })

  it("returns all nulls below period+1 bars", () => {
    expect(computeRSI([1, 2, 3], 5).every(v => v === null)).toBe(true)
  })
})

describe("computeMACD", () => {
  it("histogram = macd − signal, at every index where both exist", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 10)
    const { macd, signal, histogram } = computeMACD(closes)
    let checked = 0
    for (let i = 0; i < closes.length; i++) {
      if (macd[i] != null && signal[i] != null) {
        expect(histogram[i]!).toBeCloseTo(macd[i]! - signal[i]!, 10)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(30)   // the identity was actually exercised
  })

  it("macd is EMA(fast) − EMA(slow), so it is zero on a flat series", () => {
    const { macd, histogram } = computeMACD(Array(80).fill(50))
    expect(macd.at(-1)).toBeCloseTo(0, 10)
    expect(histogram.at(-1)).toBeCloseTo(0, 10)
  })

  it("goes positive when the fast EMA leads a rally", () => {
    const closes = [...Array(40).fill(100), ...Array.from({ length: 20 }, (_, i) => 100 + i * 3)]
    expect(computeMACD(closes).macd.at(-1)!).toBeGreaterThan(0)
  })

  it("the signal line lags the macd line, so the histogram leads the turn", () => {
    const closes = [...Array(40).fill(100), ...Array.from({ length: 20 }, (_, i) => 100 + i * 3)]
    const { macd, signal, histogram } = computeMACD(closes)
    expect(macd.at(-1)!).toBeGreaterThan(signal.at(-1)!)
    expect(histogram.at(-1)!).toBeGreaterThan(0)
  })

  it("the signal line is aligned to the macd line's own start, not to index 0", () => {
    // sigLine is written at firstValid + i; an off-by-one there would shift
    // every histogram value against its bar.
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    const { macd, signal } = computeMACD(closes)
    const firstMacd   = macd.findIndex(v => v != null)
    const firstSignal = signal.findIndex(v => v != null)
    expect(firstSignal).toBe(firstMacd + 8)   // EMA(9) of the macd values
  })

  it("yields no signal line at all when there are too few macd values", () => {
    const { macd, signal } = computeMACD(Array.from({ length: 30 }, (_, i) => 100 + i))
    expect(macd.some(v => v != null)).toBe(true)     // macd starts at bar 25
    expect(signal.every(v => v === null)).toBe(true) // but < 9 of them exist
  })

  it("honours custom periods", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i)
    const fast = computeMACD(closes, 3, 6, 2)
    expect(fast.macd.findIndex(v => v != null)).toBe(5)   // EMA(6) starts at index 5
  })
})
