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

/**
 * Minimum bars needed before a slow-MA cross can be trusted.
 *
 * computeMA(closes, slowPeriod) is null until index slowPeriod-1, so the first
 * few computable MA values are the series just initializing. A fast/slow cross
 * detected in that window is an artifact of the MA turning on, not a real
 * crossover. Require `slowPeriod + 5` bars so there is settled MA history on
 * both sides of any detected cross. Callers that fetch from a thin cache (see
 * cache.ts bar-depth) must gate on this before trusting a signal.
 */
export function hasSufficientBars(barCount: number, slowPeriod: number): boolean {
  return barCount >= slowPeriod + 5
}

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
 * Confidence is the fraction of *applicable* factors that pass, not a raw
 * count. RSI needs ≥15 bars and MACD needs ≥34 bars, so on short history
 * (small custom MA pairs, freshly-listed symbols) those factors have no data
 * and are excluded from the denominator rather than counted as failures —
 * otherwise a strong cross would be systematically capped at medium/low.
 *
 * high:   ≥75% of applicable factors pass
 * medium: ≥50% of applicable factors pass
 * low:    below 50%
 *
 * With full history all 4 factors apply and this reduces exactly to the
 * original 3+→high / 2→medium / ≤1→low thresholds.
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

  // Each factor tracks (a) whether it *applies* (has enough data) and (b) whether
  // it passed. Confidence is passed / applicable, so missing RSI/MACD on short
  // history neither counts against nor inflates the score.

  // ── Factor 1: Volume — cross-bar volume > 10-day avg × 1.2 ──────────────
  const recentVol = volumes.slice(Math.max(0, crossIndex - 10), crossIndex)
  const avgVol    = recentVol.length > 0
    ? recentVol.reduce((s, v) => s + v, 0) / recentVol.length : 0
  const signalVol = volumes[crossIndex] ?? 0
  const volApplies = avgVol > 0
  const volOk      = volApplies && signalVol > avgVol * 1.2

  // ── Factor 2: Proximity — latest close within 15% of MA60 ───────────────
  const latestClose = closes[closes.length - 1] ?? 0
  const proxApplies = curMa60 != null && curMa60 !== 0
  const proximityOk = proxApplies
    ? Math.abs(latestClose - (curMa60 as number)) / (curMa60 as number) <= 0.15 : false

  // ── Factor 3: RSI directional alignment (needs ≥15 bars) ─────────────────
  const rsiApplies = latestRsi != null
  const rsiOk      = rsiApplies
    ? (signal === "golden_cross" ? (latestRsi as number) > 50 : (latestRsi as number) < 50) : false

  // ── Factor 4: MACD histogram momentum confirmation (needs ≥34 bars) ──────
  const macdApplies = latestHist != null
  const macdOk      = macdApplies
    ? (signal === "golden_cross" ? (latestHist as number) > 0 : (latestHist as number) < 0) : false

  const applicable = [volApplies, proxApplies, rsiApplies, macdApplies].filter(Boolean).length
  const passed     = [volOk, proximityOk, rsiOk, macdOk].filter(Boolean).length
  const ratio      = applicable > 0 ? passed / applicable : 0
  // "high" also requires ≥2 independent confirmations, so a lone surviving
  // factor (e.g. proximity only, when volume is 0 and RSI/MACD lack history)
  // can't reach top confidence on 1/1 = 100%.
  const confidence: Confidence =
    ratio >= 0.75 && applicable >= 2 ? "high"
    : ratio >= 0.5 ? "medium"
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
