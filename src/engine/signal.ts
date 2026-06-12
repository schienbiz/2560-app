/**
 * Signal detection: golden cross, death cross, confidence scoring.
 *
 * TWO SCAN MODES:
 *
 *   detectCross(ma25, ma60)
 *     → checks only the last bar transition (prev → cur)
 *     → used by the cron scanner so each cross fires exactly once
 *
 *   findRecentSignal(ma25, ma60, lookback)
 *     → scans the last `lookback` bar transitions
 *     → used by analyzeSymbol for display (show the most recent cross)
 *
 * STATE MACHINE per LeaveRequest:
 *
 *   prices[] ──► MA25[] + MA60[]
 *                    │
 *          findRecentSignal()
 *                    │
 *        ┌───────────┼───────────┐
 *   golden_cross  death_cross  none
 *                    │
 *             scoreSignal()
 *                    │
 *        ┌───────────┼───────────┐
 *      high        medium       low
 */

import type { OHLCV } from "./types.js"
import { computeMA, lastN, lastNonNull } from "./ma.js"
import { computeRSI, computeMACD } from "./indicators.js"

export type SignalType = "golden_cross" | "death_cross" | "none"
export type Confidence = "high" | "medium" | "low"

export interface SignalResult {
  signal:      SignalType
  confidence:  Confidence
  ma25:        number | null
  ma60:        number | null
  crossIndex:  number | null   // bar index where the cross occurred
  rsi:         number | null   // RSI(14) at latest bar
  macdHist:    number | null   // MACD(12/26/9) histogram at latest bar
}

/**
 * Check whether the most recent bar transition produced a cross.
 * Strict: only fires on the exact bar where MAs switch sides.
 * Used by the daily cron to avoid duplicate notifications.
 */
export function detectCross(
  ma25: (number | null)[],
  ma60: (number | null)[]
): { type: SignalType; index: number | null } {
  const len = ma25.length
  if (len < 2) return { type: "none", index: null }

  // Walk backwards to find the last two non-null positions for both series
  let cur = len - 1
  while (cur >= 1 && (ma25[cur] === null || ma60[cur] === null)) cur--
  let prev = cur - 1
  while (prev >= 0 && (ma25[prev] === null || ma60[prev] === null)) prev--

  if (prev < 0) return { type: "none", index: null }

  const p25 = ma25[prev] as number
  const c25 = ma25[cur] as number
  const p60 = ma60[prev] as number
  const c60 = ma60[cur] as number

  if (p25 <= p60 && c25 > c60) return { type: "golden_cross", index: cur }
  if (p25 >= p60 && c25 < c60) return { type: "death_cross",  index: cur }
  return { type: "none", index: null }
}

/**
 * Scan the last `lookback` bar transitions for the most recent cross.
 * Used by analyzeSymbol for chart display — shows the most recent signal
 * even if it happened a few bars ago.
 */
export function findRecentSignal(
  ma25: (number | null)[],
  ma60: (number | null)[],
  lookback = 5
): { type: SignalType; index: number | null } {
  const len = ma25.length

  for (let i = len - 1; i >= Math.max(1, len - lookback); i--) {
    if (ma25[i] === null || ma60[i] === null) continue
    if (ma25[i - 1] === null || ma60[i - 1] === null) continue

    const p25 = ma25[i - 1] as number
    const c25 = ma25[i] as number
    const p60 = ma60[i - 1] as number
    const c60 = ma60[i] as number

    if (p25 <= p60 && c25 > c60) return { type: "golden_cross", index: i }
    if (p25 >= p60 && c25 < c60) return { type: "death_cross",  index: i }
  }

  return { type: "none", index: null }
}

/**
 * Score a signal's reliability using 4 confirmation factors.
 *
 * Factor 1 — Volume:    cross-bar volume > 10-day avg × 1.2
 * Factor 2 — Proximity: latest close within 15% of MA60
 * Factor 3 — RSI:       RSI(14) > 50 for golden; < 50 for death cross
 * Factor 4 — MACD:      MACD(12/26/9) histogram ≥ 0 for golden; ≤ 0 for death
 *
 * high:   3+ of 4 pass
 * medium: 2 of 4 pass
 * low:    0–1 pass
 */
export function scoreSignal(
  ohlcv: OHLCV[],
  ma25: (number | null)[],
  ma60: (number | null)[],
  lookback = 5
): SignalResult {
  const { type: signal, index: crossIndex } = findRecentSignal(ma25, ma60, lookback)

  const curMa25 = lastNonNull(ma25)
  const curMa60 = lastNonNull(ma60)

  const closes  = ohlcv.map(b => b.close)
  const volumes = ohlcv.map(b => b.volume)

  // Compute RSI and MACD for latest bar (used both in scoring and returned to caller)
  const rsiSeries  = computeRSI(closes)
  const macdSeries = computeMACD(closes)
  const latestRsi  = lastNonNull(rsiSeries)
  const latestHist = lastNonNull(macdSeries.histogram)

  if (signal === "none" || crossIndex === null) {
    return { signal, confidence: "low", ma25: curMa25, ma60: curMa60, crossIndex: null, rsi: latestRsi, macdHist: latestHist }
  }

  // ── Factor 1: Volume — cross-bar volume > 10-day avg × 1.2 ──────────────
  const recentVol = volumes.slice(Math.max(0, crossIndex - 10), crossIndex)
  const avgVol    = recentVol.length > 0
    ? recentVol.reduce((s, v) => s + v, 0) / recentVol.length : 0
  const signalVol = volumes[crossIndex] ?? 0
  const volOk     = avgVol > 0 && signalVol > avgVol * 1.2

  // ── Factor 2: Proximity — latest close within 15% of MA60 ───────────────
  const latestClose = closes[closes.length - 1] ?? 0
  const proximityOk = curMa60 != null
    ? Math.abs(latestClose - curMa60) / curMa60 <= 0.15 : false

  // ── Factor 3: RSI directional alignment ──────────────────────────────────
  const rsiOk = latestRsi != null
    ? (signal === "golden_cross" ? latestRsi > 50 : latestRsi < 50) : false

  // ── Factor 4: MACD histogram momentum confirmation ───────────────────────
  const macdOk = latestHist != null
    ? (signal === "golden_cross" ? latestHist > 0 : latestHist < 0) : false

  const passed = [volOk, proximityOk, rsiOk, macdOk].filter(Boolean).length
  const confidence: Confidence =
    passed >= 3 ? "high"
    : passed >= 2 ? "medium"
    : "low"

  return { signal, confidence, ma25: curMa25, ma60: curMa60, crossIndex, rsi: latestRsi, macdHist: latestHist }
}

/**
 * Full pipeline: raw OHLCV → signal result.
 * Uses findRecentSignal (lookback=5) so chart display catches crosses
 * from the last 5 bars, not just the exact last bar.
 */
export function analyzeSymbol(ohlcv: OHLCV[], fastPeriod = 25, slowPeriod = 60): SignalResult {
  const closes = ohlcv.map(b => b.close)
  const ma25   = computeMA(closes, fastPeriod)
  const ma60   = computeMA(closes, slowPeriod)
  return scoreSignal(ohlcv, ma25, ma60)
}
