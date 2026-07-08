import { describe, it, expect } from "vitest"
import { scoreStrongDeath, formatStrongDeathLine, STRONG_DEATH_LABELS } from "../src/engine/strong-death.js"
import { computeRSI, computeEMA } from "../src/engine/indicators.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A series engineered so all five bearish factors pass (values verified by
 * grid search against the real indicator implementations):
 * 100 flat bars, 120 bars of gentle sawtooth decline, then a 13-bar steeper
 * tail. The tail acceleration keeps the MACD histogram negative (a decline
 * that *softens* flips the histogram positive), while the sawtooth keeps
 * RSI in the 35–50 band (≈38) instead of pinning near 0.
 */
function allBearishCloses(): number[] {
  const closes: number[] = []
  for (let i = 0; i < 100; i++) closes.push(130)
  let p = 130
  for (let i = 0; i < 120; i++) { p += i % 2 === 0 ? -0.4 : +0.3; closes.push(p) }
  for (let i = 0; i < 12; i++) { p += i % 2 === 0 ? -0.9 : +0.6; closes.push(p) }
  closes.push(p - 0.9)                                              // end on a down bar
  return closes                                                     // 233 bars
}

/** Market index in a clear downtrend: last close far below its MA200. */
function bearMarketCloses(): number[] {
  const closes: number[] = []
  for (let i = 0; i < 150; i++) closes.push(400)
  for (let i = 0; i < 100; i++) closes.push(400 - i * 1.5)          // → 251.5
  return closes                                                     // 250 bars
}

/** Market index in an uptrend: last close far above its MA200. */
function bullMarketCloses(): number[] {
  const closes: number[] = []
  for (let i = 0; i < 250; i++) closes.push(300 + i)                // → 549
  return closes
}

// ─── scoreStrongDeath ────────────────────────────────────────────────────────

describe("scoreStrongDeath", () => {
  it("all five factors pass on a confirmed bear setup → isStrong", () => {
    const closes = allBearishCloses()

    // sanity: the engineered series really is in the RSI mid-band and Vegas-bearish
    const rsi = computeRSI(closes).at(-1)!
    expect(rsi).toBeGreaterThanOrEqual(35)
    expect(rsi).toBeLessThanOrEqual(50)
    expect(computeEMA(closes, 144).at(-1)!).toBeLessThan(computeEMA(closes, 169).at(-1)!)

    const r = scoreStrongDeath(closes, bearMarketCloses())
    expect(r.factors).toEqual({ vegas: true, macd: true, slope: true, rsi: true, market: true })
    expect(r.passed).toBe(5)
    expect(r.applicable).toBe(5)
    expect(r.isStrong).toBe(true)
  })

  it("bull market index fails the market factor → not strong", () => {
    const r = scoreStrongDeath(allBearishCloses(), bullMarketCloses())
    expect(r.factors.market).toBe(false)
    expect(r.passed).toBe(4)
    expect(r.isStrong).toBe(false)
  })

  it("missing market data → market factor null, never strong (fail-closed)", () => {
    const r = scoreStrongDeath(allBearishCloses(), null)
    expect(r.factors.market).toBeNull()
    expect(r.applicable).toBe(4)
    expect(r.passed).toBe(4)
    expect(r.isStrong).toBe(false)
  })

  it("market series shorter than 200 bars → market factor null", () => {
    const r = scoreStrongDeath(allBearishCloses(), bearMarketCloses().slice(-150))
    expect(r.factors.market).toBeNull()
    expect(r.isStrong).toBe(false)
  })

  it("symbol history shorter than EMA169 → vegas factor null, never strong", () => {
    const closes = allBearishCloses().slice(-120)   // 120 bars: slope/rsi/macd computable
    const r = scoreStrongDeath(closes, bearMarketCloses())
    expect(r.factors.vegas).toBeNull()
    expect(r.applicable).toBeLessThan(5)
    expect(r.isStrong).toBe(false)
  })

  it("rising trend fails the bearish factors", () => {
    const closes: number[] = []
    for (let i = 0; i < 270; i++) closes.push(100 + i)              // straight up
    const r = scoreStrongDeath(closes, bullMarketCloses())
    expect(r.factors.vegas).toBe(false)   // EMA144 > EMA169 in an uptrend
    expect(r.factors.slope).toBe(false)   // MA60 rising
    expect(r.factors.market).toBe(false)
    expect(r.isStrong).toBe(false)
  })

  it("respects a custom slow period for the slope factor", () => {
    // 90 bars: enough for slope with slowPeriod=20 but vegas stays null
    const closes = allBearishCloses().slice(-90)
    const r = scoreStrongDeath(closes, null, 20)
    expect(r.factors.slope).toBe(true)    // MA20 falling in the decline
    expect(r.factors.vegas).toBeNull()
  })

  it("empty closes → every symbol factor null, never strong, no crash", () => {
    const r = scoreStrongDeath([], bearMarketCloses())
    expect(r.factors.vegas).toBeNull()
    expect(r.factors.macd).toBeNull()
    expect(r.factors.slope).toBeNull()
    expect(r.factors.rsi).toBeNull()
    expect(r.factors.market).toBe(true)   // market factor is independent of symbol data
    expect(r.passed).toBe(1)
    expect(r.isStrong).toBe(false)
  })

  it("10-bar history → all factors null (below every indicator minimum)", () => {
    const r = scoreStrongDeath([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], null)
    expect(r.applicable).toBe(0)
    expect(r.passed).toBe(0)
    expect(r.isStrong).toBe(false)
  })
})

// ─── formatStrongDeathLine ───────────────────────────────────────────────────

describe("formatStrongDeathLine", () => {
  it("5/5 → 強確認 headline; 83% claim only with backtested=true (MA25/60)", () => {
    const r = scoreStrongDeath(allBearishCloses(), bearMarketCloses())
    const backtested = formatStrongDeathLine(r, true)
    expect(backtested).toContain("⚡ 強確認死叉 5/5")
    expect(backtested).toContain("83%")
    const custom = formatStrongDeathLine(r)   // custom MA pair: no unvalidated statistic
    expect(custom).toContain("⚡ 強確認死叉 5/5")
    expect(custom).not.toContain("83%")
  })

  it("failed factors and missing data render together, ；-separated", () => {
    // 120-bar symbol (vegas null → 資料不足) + bull market (market false → 未過)
    const line = formatStrongDeathLine(scoreStrongDeath(allBearishCloses().slice(-120), bullMarketCloses()))
    expect(line).toContain(`未過：${STRONG_DEATH_LABELS.market}`)
    expect(line).toContain("資料不足1項")
    expect(line).toContain("；")
  })

  it("partial pass lists the failed factors by label", () => {
    const line = formatStrongDeathLine(scoreStrongDeath(allBearishCloses(), bullMarketCloses()))
    expect(line).toContain("死叉確認 4/5")
    expect(line).toContain(`未過：${STRONG_DEATH_LABELS.market}`)
  })

  it("missing data is reported as 資料不足, not as a failed factor", () => {
    const line = formatStrongDeathLine(scoreStrongDeath(allBearishCloses(), null))
    expect(line).toContain("死叉確認 4/5")
    expect(line).toContain("資料不足1項")
    expect(line).not.toContain(STRONG_DEATH_LABELS.market)
  })
})
