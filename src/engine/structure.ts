/**
 * Price action structure analysis.
 *
 * Computes from raw OHLCV + MA arrays:
 *   - Swing highs/lows labeled as HH / HL / LH / LL
 *   - Trend phase: impulse_up | impulse_down | correction | range
 *   - ATR(14) for risk sizing context
 *   - Overall bias: bullish | bearish | neutral
 *
 * Used by the AI analysis service to give structured,
 * price-action-grounded output rather than only MA signal wording.
 */

import type { OHLCV } from "./types.js"

// ─── Public types ─────────────────────────────────────────────────────────────

export type TrendPhase = "impulse_up" | "impulse_down" | "correction" | "range"
export type SwingLabel = "HH" | "HL" | "LH" | "LL"
export type Bias = "bullish" | "bearish" | "neutral"

export interface SwingPoint {
  date:  string
  price: number
  kind:  "high" | "low"
  label: SwingLabel
}

export interface StructureData {
  phase:  TrendPhase
  swings: SwingPoint[]   // last 6 labeled swings, oldest→newest
  atr14:  number
  bias:   Bias
}

// ─── ATR(14) ─────────────────────────────────────────────────────────────────

function calcATR14(ohlcv: OHLCV[]): number {
  const bars = ohlcv.slice(-15)
  if (bars.length < 2) return 0
  let sum = 0
  for (let i = 1; i < bars.length; i++) {
    const cur  = bars[i]
    const prev = bars[i - 1]
    sum += Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low  - prev.close),
    )
  }
  return sum / (bars.length - 1)
}

// ─── Pivot detection ─────────────────────────────────────────────────────────

type RawPivot = { date: string; price: number; idx: number; kind: "high" | "low" }

function findPivots(ohlcv: OHLCV[], lookback = 3): RawPivot[] {
  const pivots: RawPivot[] = []

  for (let i = lookback; i < ohlcv.length - lookback; i++) {
    const bar = ohlcv[i]

    const isHigh = ohlcv
      .slice(i - lookback, i + lookback + 1)
      .every((b, j) => j === lookback || b.high <= bar.high)

    const isLow = ohlcv
      .slice(i - lookback, i + lookback + 1)
      .every((b, j) => j === lookback || b.low >= bar.low)

    if (isHigh) pivots.push({ date: bar.date, price: bar.high, idx: i, kind: "high" })
    if (isLow)  pivots.push({ date: bar.date, price: bar.low,  idx: i, kind: "low"  })
  }

  // Sort by time, then deduplicate consecutive same-kind (keep more extreme)
  const sorted = pivots.sort((a, b) => a.idx - b.idx)
  const deduped: RawPivot[] = []

  for (const p of sorted) {
    const last = deduped[deduped.length - 1]
    if (!last || last.kind !== p.kind) {
      deduped.push(p)
    } else if (p.kind === "high" && p.price >= last.price) {
      deduped[deduped.length - 1] = p
    } else if (p.kind === "low" && p.price <= last.price) {
      deduped[deduped.length - 1] = p
    }
  }

  return deduped
}

// ─── Label swings as HH/HL/LH/LL ────────────────────────────────────────────

function labelSwings(pivots: RawPivot[]): SwingPoint[] {
  const last6  = pivots.slice(-6)
  const swings: SwingPoint[] = []
  let lastHighPrice: number | null = null
  let lastLowPrice:  number | null = null

  for (const p of last6) {
    if (p.kind === "high") {
      const label: SwingLabel =
        lastHighPrice === null ? "HH"
        : p.price > lastHighPrice ? "HH"
        : "LH"
      swings.push({ date: p.date, price: p.price, kind: "high", label })
      lastHighPrice = p.price
    } else {
      const label: SwingLabel =
        lastLowPrice === null ? "HL"
        : p.price > lastLowPrice ? "HL"
        : "LL"
      swings.push({ date: p.date, price: p.price, kind: "low", label })
      lastLowPrice = p.price
    }
  }

  return swings
}

// ─── Trend phase ─────────────────────────────────────────────────────────────

function classifyPhase(
  close:   number,
  ma25:    number | null,
  ma60:    number | null,
): { phase: TrendPhase; bias: Bias } {
  if (ma25 === null || ma60 === null) return { phase: "range", bias: "neutral" }

  const spread = Math.abs(ma25 - ma60) / ma60

  // MAs converged within 0.5% → range
  if (spread < 0.005) return { phase: "range", bias: "neutral" }

  if (ma25 > ma60) {
    // Bullish MA alignment
    return {
      bias:  "bullish",
      phase: close >= ma25 ? "impulse_up" : "correction",
    }
  } else {
    // Bearish MA alignment
    return {
      bias:  "bearish",
      phase: close <= ma25 ? "impulse_down" : "correction",
    }
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function computeStructure(
  ohlcv: OHLCV[],
  ma25:  (number | null)[],
  ma60:  (number | null)[],
): StructureData {
  if (ohlcv.length < 10) {
    return { phase: "range", swings: [], atr14: 0, bias: "neutral" }
  }

  const recent  = ohlcv.slice(-60)
  const pivots  = findPivots(recent, 3)
  const swings  = labelSwings(pivots)

  const close  = ohlcv[ohlcv.length - 1].close
  const curMa25 = [...ma25].reverse().find(v => v != null) ?? null
  const curMa60 = [...ma60].reverse().find(v => v != null) ?? null

  const { phase, bias } = classifyPhase(close, curMa25, curMa60)

  return {
    phase,
    swings,
    atr14: calcATR14(ohlcv),
    bias,
  }
}
