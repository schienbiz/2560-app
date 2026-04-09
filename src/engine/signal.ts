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
import { computeMA, lastN } from "./ma.js"

export type SignalType = "golden_cross" | "death_cross" | "none"
export type Confidence = "high" | "medium" | "low"

export interface SignalResult {
  signal:      SignalType
  confidence:  Confidence
  ma25:        number | null
  ma60:        number | null
  crossIndex:  number | null   // bar index where the cross occurred
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
 * Score a signal's reliability.
 *
 * high:   cross confirmed + volume above 10-day avg × 1.2
 *         + price within 15% of MA60
 * medium: one of the two confirmation checks passed
 * low:    cross confirmed but both checks failed
 */
export function scoreSignal(
  ohlcv: OHLCV[],
  ma25: (number | null)[],
  ma60: (number | null)[],
  lookback = 5
): SignalResult {
  const { type: signal, index: crossIndex } = findRecentSignal(ma25, ma60, lookback)

  const curMa25 = lastN(ma25, 1)[0] ?? null
  const curMa60 = lastN(ma60, 1)[0] ?? null

  if (signal === "none" || crossIndex === null) {
    return { signal, confidence: "low", ma25: curMa25, ma60: curMa60, crossIndex: null }
  }

  const closes  = ohlcv.map(b => b.close)
  const volumes = ohlcv.map(b => b.volume)

  // Volume check: cross-bar volume > 10-day average × 1.2
  const recentVol = volumes.slice(Math.max(0, crossIndex - 10), crossIndex)
  const avgVol    = recentVol.length > 0
    ? recentVol.reduce((s, v) => s + v, 0) / recentVol.length
    : 0
  const signalVol = volumes[crossIndex] ?? 0
  const volOk = avgVol > 0 && signalVol > avgVol * 1.2

  // Proximity check: latest close within 15% of MA60
  const latestClose = closes[closes.length - 1] ?? 0
  const proximityOk = curMa60 !== null
    ? Math.abs(latestClose - curMa60) / curMa60 <= 0.15
    : false

  const confidence: Confidence =
    volOk && proximityOk ? "high"
    : volOk || proximityOk ? "medium"
    : "low"

  return { signal, confidence, ma25: curMa25, ma60: curMa60, crossIndex }
}

/**
 * Full pipeline: raw OHLCV → signal result.
 * Uses findRecentSignal (lookback=5) so chart display catches crosses
 * from the last 5 bars, not just the exact last bar.
 */
export function analyzeSymbol(ohlcv: OHLCV[]): SignalResult {
  const closes = ohlcv.map(b => b.close)
  const ma25   = computeMA(closes, 25)
  const ma60   = computeMA(closes, 60)
  return scoreSignal(ohlcv, ma25, ma60)
}
