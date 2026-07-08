/**
 * Strong-confirmation death cross scoring (5-factor 強確認死叉).
 *
 * Backtested 2026-07-08 on 16 symbols × ~9y of daily bars (577 crosses,
 * time-split validated train <2024 / test ≥2024): death crosses where all
 * five bearish factors confirm showed ~83% 5-day precision (n=23, Wilson
 * 95% LB 63%); ≥4 factors → 72% overall, 78% in the test period. Precision
 * rises monotonically with factor count (36→47→40→62→66→83%), which is why
 * the count itself is surfaced, not just the 5/5 label.
 *
 * The five factors, all evaluated at the death-cross bar on settled closes:
 *   vegas  — Vegas tunnel bearish alignment: EMA144 < EMA169
 *   macd   — MACD(12/26/9) histogram < 0
 *   slope  — slow MA falling: MA(slow)[last] < MA(slow)[last-5]
 *   rsi    — RSI(14) in the 35–50 band (weak but not washed-out)
 *   market — market index (BTC / SPY / 0050) closed at or below its MA200
 *
 * Data requirements: the symbol needs ≥169 bars (EMA169) and the market
 * series ≥200 bars (MA200); factors without enough history are `null`
 * (inapplicable) and count against `isStrong` — a cross can only be
 * "strong" when all five factors are computable AND pass (fail-closed).
 *
 * Pure: no DB, no fetch, no side effects.
 */

import { computeMA } from "./ma.js"
import { computeEMA, computeRSI, computeMACD } from "./indicators.js"

export interface StrongDeathFactors {
  vegas:  boolean | null
  macd:   boolean | null
  slope:  boolean | null
  rsi:    boolean | null
  market: boolean | null
}

export interface StrongDeathResult {
  factors:    StrongDeathFactors
  passed:     number   // factors that are true
  applicable: number   // factors that are non-null (had enough data)
  isStrong:   boolean  // all 5 applicable and all 5 passed
}

const VEGAS_FAST = 144
const VEGAS_SLOW = 169
const MARKET_MA  = 200
const SLOPE_BARS = 5
const RSI_LOW    = 35
const RSI_HIGH   = 50

/**
 * Score the 5 bearish confirmation factors at the last bar of `closes`.
 *
 * @param closes       settled daily closes of the symbol, oldest → newest,
 *                     with the death-cross bar last
 * @param marketCloses settled daily closes of the market index (BTC / SPY /
 *                     0050), or null when unavailable
 * @param slowPeriod   the slow MA period of the cross that fired (default 60)
 */
export function scoreStrongDeath(
  closes: number[],
  marketCloses: number[] | null,
  slowPeriod = 60
): StrongDeathResult {
  const last = closes.length - 1

  // ── vegas: EMA144 < EMA169 ────────────────────────────────────────────
  let vegas: boolean | null = null
  if (closes.length >= VEGAS_SLOW) {
    const e144 = computeEMA(closes, VEGAS_FAST)[last]
    const e169 = computeEMA(closes, VEGAS_SLOW)[last]
    if (e144 != null && e169 != null) vegas = e144 < e169
  }

  // ── macd: histogram < 0 ──────────────────────────────────────────────
  const hist = computeMACD(closes).histogram[last]
  const macd: boolean | null = hist != null ? hist < 0 : null

  // ── slope: slow MA falling over the last 5 bars ──────────────────────
  let slope: boolean | null = null
  if (closes.length > slowPeriod + SLOPE_BARS) {
    const ma = computeMA(closes, slowPeriod)
    const cur = ma[last], prev = ma[last - SLOPE_BARS]
    if (cur != null && prev != null) slope = cur < prev
  }

  // ── rsi: RSI(14) in 35–50 ────────────────────────────────────────────
  const rsiVal = computeRSI(closes)[last]
  const rsi: boolean | null = rsiVal != null ? rsiVal >= RSI_LOW && rsiVal <= RSI_HIGH : null

  // ── market: index close ≤ its MA200 ──────────────────────────────────
  let market: boolean | null = null
  if (marketCloses != null && marketCloses.length >= MARKET_MA) {
    const mLast = marketCloses.length - 1
    const ma200 = computeMA(marketCloses, MARKET_MA)[mLast]
    if (ma200 != null) market = marketCloses[mLast] <= ma200
  }

  const factors: StrongDeathFactors = { vegas, macd, slope, rsi, market }
  const vals = Object.values(factors)
  const passed = vals.filter(v => v === true).length
  const applicable = vals.filter(v => v !== null).length

  return { factors, passed, applicable, isStrong: applicable === FACTOR_COUNT && passed === FACTOR_COUNT }
}

/** 中文標籤，通知與 UI 共用 */
export const STRONG_DEATH_LABELS: Record<keyof StrongDeathFactors, string> = {
  vegas:  "Vegas空頭排列",
  macd:   "MACD柱轉負",
  slope:  "MA下彎",
  rsi:    "RSI偏弱",
  market: "大盤走弱",
}

/** Single source of truth for the factor count in isStrong and display strings. */
export const FACTOR_COUNT = Object.keys(STRONG_DEATH_LABELS).length

/**
 * Notification line for a death cross.
 *   5/5           → ⚡ 強確認死叉 5/5 — 全因子空頭確認（回測5日精準度83%）
 *   partial       → 死叉確認 3/5（未過：大盤走弱、RSI偏弱）
 *   missing data  → appends 「資料不足N項」 so a low count isn't mistaken for
 *                   factors actually failing
 *
 * The 83% backtest claim was measured on MA25/60 crosses only, so it is only
 * emitted when `backtested` is true (caller confirms the alert uses the
 * backtested MA pair). Custom-period alerts get the tier label without the
 * unvalidated statistic.
 */
export function formatStrongDeathLine(r: StrongDeathResult, backtested = false): string {
  if (r.isStrong) {
    const stat = backtested ? "（回測5日精準度83%）" : ""
    return `⚡ 強確認死叉 ${FACTOR_COUNT}/${FACTOR_COUNT} — 全因子空頭確認${stat}`
  }

  const failed = (Object.keys(r.factors) as (keyof StrongDeathFactors)[])
    .filter(k => r.factors[k] === false)
    .map(k => STRONG_DEATH_LABELS[k])
  const parts: string[] = []
  if (failed.length > 0) parts.push(`未過：${failed.join("、")}`)
  if (r.applicable < FACTOR_COUNT) parts.push(`資料不足${FACTOR_COUNT - r.applicable}項`)
  const detail = parts.length > 0 ? `（${parts.join("；")}）` : ""
  return `死叉確認 ${r.passed}/${FACTOR_COUNT}${detail}`
}
