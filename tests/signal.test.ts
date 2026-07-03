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
//
// Confidence = passed / applicable factors. RSI needs ≥15 bars, MACD needs
// ≥34 bars, so on short (11-bar) history only volume + proximity apply and the
// denominator is 2; with ≥34 bars all four apply and the denominator is 4.

describe("scoreSignal — short history (only volume + proximity apply)", () => {
  it("2/2 applicable pass → high (RSI/MACD null must not cap it at medium)", () => {
    // 11 bars < 15 → RSI/MACD null → excluded. Regression guard for the
    // short-history under-scoring bug: this used to yield 2/4 = medium.
    const ohlcv: OHLCV[] = [
      ...Array(10).fill(bar(100, 1000)),
      bar(102, 2000),   // cross bar: close=102, vol=2000 (>1100×1.2=1320) ✓
    ]
    const ma25 = [...Array(10).fill(99), 101] as (number | null)[]
    const ma60 = Array(11).fill(100) as (number | null)[]
    // proximity: |102 - 100|/100 = 2% ≤ 15% ✓  → 2/2 applicable pass → HIGH
    const result = scoreSignal(ohlcv, ma25, ma60)
    expect(result.signal).toBe("golden_cross")
    expect(result.rsi).toBeNull()      // proves RSI is genuinely absent here
    expect(result.macdHist).toBeNull()
    expect(result.confidence).toBe("high")
  })

  it("1/2 applicable pass → medium (volume spikes, proximity far)", () => {
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

  it("1/1 applicable (proximity only, zero volume) → medium, not high", () => {
    // Zero volume everywhere → volume factor doesn't apply; RSI/MACD null on
    // 11 bars. Only proximity applies and passes: 1/1 = 100%, but the ≥2
    // breadth guard caps a lone factor at medium.
    const ohlcv: OHLCV[] = [
      ...Array(10).fill(bar(100, 0)),
      bar(102, 0),      // close near MA60, no volume signal
    ]
    const ma25 = [...Array(10).fill(99), 101] as (number | null)[]
    const ma60 = Array(11).fill(100) as (number | null)[]
    expect(scoreSignal(ohlcv, ma25, ma60).confidence).toBe("medium")
  })

  it("0/2 applicable pass → low (no volume spike, proximity far)", () => {
    const ohlcv: OHLCV[] = [
      ...Array(10).fill(bar(100, 1000)),
      bar(140, 1000),   // no vol spike, close far → both fail
    ]
    const ma25 = [...Array(10).fill(99), 101] as (number | null)[]
    const ma60 = Array(11).fill(100) as (number | null)[]
    expect(scoreSignal(ohlcv, ma25, ma60).confidence).toBe("low")
  })
})

describe("scoreSignal — full history (all four factors apply)", () => {
  // 40 rising bars → RSI > 50 and MACD histogram > 0, so both momentum factors
  // are present AND aligned with a golden cross.
  function risingOhlcv(volAtLast = 2000): OHLCV[] {
    const bars: OHLCV[] = []
    for (let i = 0; i < 40; i++) bars.push(bar(85 + i * (15 / 39), 1000))
    bars[39] = { ...bars[39], volume: volAtLast }
    return bars
  }
  // Cross lands on the last bar; MA60 = 100 so close (≈100) is right at it.
  const risingMa25 = [...Array(39).fill(99), 101] as (number | null)[]
  const risingMa60 = Array(40).fill(100) as (number | null)[]

  it("4/4 apply and pass → high", () => {
    const result = scoreSignal(risingOhlcv(), risingMa25, risingMa60)
    expect(result.signal).toBe("golden_cross")
    expect(result.rsi).not.toBeNull()      // RSI/MACD genuinely present now
    expect(result.macdHist).not.toBeNull()
    expect(result.confidence).toBe("high")
  })

  it("2/4 apply-and-pass → medium (RSI & MACD misaligned on a falling series)", () => {
    // 40 falling bars → RSI < 50, MACD hist < 0: both momentum factors present
    // but fail directional alignment for a golden cross. Volume + proximity pass.
    const bars: OHLCV[] = []
    for (let i = 0; i < 40; i++) bars.push(bar(100 - i * (15 / 39), 1000))
    bars[39] = { ...bars[39], volume: 2000 }   // vol spike ✓
    const closeLast = bars[39].close           // ≈ 85
    const ma60 = Array(40).fill(closeLast) as (number | null)[]  // proximity ✓
    const ma25 = [...Array(39).fill(closeLast - 1), closeLast + 1] as (number | null)[]
    const result = scoreSignal(bars, ma25, ma60)
    expect(result.signal).toBe("golden_cross")
    expect((result.rsi as number) < 50).toBe(true)
    expect((result.macdHist as number) < 0).toBe(true)
    expect(result.confidence).toBe("medium")   // vol+prox = 2/4
  })
})

describe("scoreSignal — no cross", () => {
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
