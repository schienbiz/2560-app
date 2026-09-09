/**
 * Binomial statistics behind the A/E report's verdicts.
 *
 * This is the code that decides whether a cell reads as a finding or as
 * 資料不足, so a wrong answer here does not crash — it quietly publishes a
 * conclusion the data does not support. Expected values come from analytic
 * identities (Wilson's mirror symmetry, the interval containing its own point
 * estimate) rather than from recording what the implementation emitted.
 */

import { describe, it, expect } from "vitest"
import {
  wilsonInterval, wilsonIntervalFromRate, wilsonLB, excludes,
  requiredN, powerReport, cellVerdict, Z_95,
} from "../src/utils/ae-stats.js"
import { coverageMatureDays, FILL_SLACK_CAL_DAYS, WINDOW_CAL_DAYS, ELIGIBLE_AGE_DAYS } from "../src/utils/outcome-math.js"

describe("wilsonInterval", () => {
  it("returns the whole unit interval for n=0 — no observations exclude nothing", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1])
  })

  it("always contains its own point estimate", () => {
    for (const [h, n] of [[0, 5], [1, 5], [3, 5], [5, 5], [6, 9], [6, 13], [1, 1]]) {
      const [lo, hi] = wilsonInterval(h, n)
      expect(lo).toBeLessThanOrEqual(h / n)
      expect(hi).toBeGreaterThanOrEqual(h / n)
    }
  })

  /**
   * Mirror symmetry: swapping hits for misses reflects the interval about 0.5.
   * An analytic property of the Wilson form, so it holds for every input — and
   * it catches a sign slip or an asymmetric margin that one hand-picked number
   * would sail past.
   */
  it("is the mirror image of the complementary count", () => {
    for (const [h, n] of [[0, 7], [2, 7], [3, 9], [6, 13], [1, 4]]) {
      const [lo, hi] = wilsonInterval(h, n)
      const [lo2, hi2] = wilsonInterval(n - h, n)
      expect(lo).toBeCloseTo(1 - hi2, 12)
      expect(hi).toBeCloseTo(1 - lo2, 12)
    }
  })

  /**
   * The DEFINING property of the Wilson score interval: its bounds are exactly
   * the two p that solve (p̂ − p)² = z²·p(1−p)/n. Asserting the definition
   * rather than a remembered number is what catches an error in the algebra's
   * scale — a margin that is off by the 1/denominator factor still produces a
   * symmetric interval that contains its point estimate and still narrows with
   * n, so every softer property test sails straight past it.
   */
  it("its bounds satisfy the score equation that defines them", () => {
    for (const [h, n] of [[6, 9], [6, 13], [1, 4], [0, 10], [10, 10], [3, 7]]) {
      const p = h / n
      for (const b of wilsonInterval(h, n)) {
        expect((p - b) ** 2).toBeCloseTo((Z_95 ** 2 * b * (1 - b)) / n, 10)
      }
    }
  })

  it("pins the bounds at 0 and 1 for the degenerate counts", () => {
    expect(wilsonInterval(0, 10)[0]).toBe(0)
    expect(wilsonInterval(10, 10)[1]).toBe(1)
    // ...but never collapses to a point: 10/10 is not proof of certainty.
    expect(wilsonInterval(10, 10)[0]).toBeGreaterThan(0)
    expect(wilsonInterval(10, 10)[0]).toBeLessThan(1)
  })

  it("narrows as n grows at a fixed rate", () => {
    let prev = Infinity
    for (const n of [4, 8, 16, 32, 64, 128]) {
      const [lo, hi] = wilsonIntervalFromRate(0.5, n)
      expect(hi - lo).toBeLessThan(prev)
      prev = hi - lo
    }
  })

  it("widens with a larger z", () => {
    const [lo, hi] = wilsonInterval(5, 20, Z_95)
    const [lo99, hi99] = wilsonInterval(5, 20, 2.576)
    expect(hi99 - lo99).toBeGreaterThan(hi - lo)
  })

  it("wilsonLB is the interval's lower bound", () => {
    expect(wilsonLB(6, 9)).toBeCloseTo(wilsonInterval(6, 9)[0], 12)
  })

  it("the rate form agrees with the count form when the rate is hits/n", () => {
    for (const [h, n] of [[6, 9], [6, 13], [1, 1], [0, 4]]) {
      const a = wilsonInterval(h, n), b = wilsonIntervalFromRate(h / n, n)
      expect(a[0]).toBeCloseTo(b[0], 12)
      expect(a[1]).toBeCloseTo(b[1], 12)
    }
  })
})

describe("excludes", () => {
  it("is false for an empty cell whatever the expected", () => {
    for (const p0 of [0.01, 0.5, 0.83, 0.99]) expect(excludes(0, 0, p0)).toBe(false)
  })

  it("catches a rate far from the expected once n is large enough", () => {
    expect(excludes(0, 30, 0.5)).toBe(true)     // 0/30 cannot be a 50% process
    expect(excludes(30, 30, 0.5)).toBe(true)
  })

  it("does not fire on the actual live cells — none of them is a finding", () => {
    // The 2026-09-09 Phase 1 pull. If any of these ever flips to true, the
    // NO-GO decision's second criterion has been met and must be revisited.
    expect(excludes(6, 9, 0.52)).toBe(false)    // death all
    expect(excludes(6, 13, 0.54)).toBe(false)   // golden all
    expect(excludes(1, 1, 0.72)).toBe(false)    // death >=4/5
  })
})

describe("requiredN", () => {
  /**
   * The finding that reshaped the Phase 1 re-trigger: for an expected of 83%
   * the high band edge is not merely far away, it is arithmetically impossible
   * — 0.83 x 1.3 = 1.079 is not a probability. A symmetric ±30% band cannot be
   * applied to a cell with a high expected.
   */
  it("returns null when the band edge is not a probability", () => {
    expect(requiredN(0.83, 1.3)).toBeNull()
    expect(requiredN(0.9, 1.2)).toBeNull()
    expect(requiredN(0.5, 1.3)).not.toBeNull()
  })

  /**
   * REGRESSION. The first implementation rounded the target to an integer
   * count, and rounding is not monotone in n: for p0=0.83 at the low edge it
   * answered n=6, yet n=7, 8 and 10 did NOT exclude 0.83. Quoting "需 n≈6"
   * would have been an artefact that evaporates on the seventh observation.
   */
  it("is a real floor: once reached, every larger n still excludes", () => {
    for (const [p0, ae] of [[0.83, 0.7], [0.72, 1.3], [0.52, 1.3], [0.54, 1.3]]) {
      const need = requiredN(p0, ae)!
      expect(need).toBeGreaterThan(0)
      for (let n = need; n <= need + 150; n++) {
        const [lo, hi] = wilsonIntervalFromRate(p0 * ae, n)
        expect(p0 < lo || p0 > hi).toBe(true)
      }
    }
  })

  it("rejects the specific rounding artefact that n=6 was", () => {
    expect(requiredN(0.83, 0.7)).toBeGreaterThan(6)
  })

  it("needs a bigger sample for a smaller deviation", () => {
    expect(requiredN(0.5, 1.5)!).toBeLessThan(requiredN(0.5, 1.2)!)
  })

  it("returns null rather than looping forever when maxN is too small", () => {
    expect(requiredN(0.5, 1.001, 50)).toBeNull()
  })
})

describe("powerReport", () => {
  it("reports the high edge as unreachable for a high expected, but still gives the low edge", () => {
    const { highN, lowN } = powerReport(0.83, 0.7, 1.3)
    expect(highN).toBeNull()
    expect(lowN).not.toBeNull()
  })

  it("gives both edges for a mid expected", () => {
    const { highN, lowN } = powerReport(0.52, 0.7, 1.3)
    expect(highN).not.toBeNull()
    expect(lowN).not.toBeNull()
  })
})

describe("cellVerdict", () => {
  it("an empty cell is never a finding", () => {
    const v = cellVerdict(0, 0, 0.83)
    expect(v.kind).toBe("empty")
    expect(v.ae).toBeNull()
  })

  it("flags a genuine deviation", () => {
    const v = cellVerdict(0, 30, 0.5)
    expect(v.kind).toBe("drifting")
    expect(v.text).toContain("偏離")
  })

  /**
   * The whole point of the rewrite: at a sample size too small to resolve the
   * band, the verdict must say so instead of printing a tidy A/E with a tick.
   */
  it("says 資料不足 — and how much more is needed — when the interval still covers the expected", () => {
    const v = cellVerdict(1, 2, 0.5)
    expect(v.kind).toBe("insufficient")
    expect(v.text).toContain("需 n≈")
  })

  it("only says 一致 once n could actually have caught a band-edge deviation", () => {
    const need = requiredN(0.5, 1.3)!
    // p-hat exactly on the expected, at twice the sample size the band needs.
    const v = cellVerdict(need, need * 2, 0.5)
    expect(v.kind).toBe("consistent")
    expect(v.ae).toBeCloseTo(1, 10)
  })

  it("the same hit rate flips from 資料不足 to 一致 purely on sample size", () => {
    const small = cellVerdict(1, 2, 0.5)
    const need = requiredN(0.5, 1.3)!
    const big = cellVerdict(need, need * 2, 0.5)
    expect(small.ae).toBeCloseTo(big.ae!, 10)   // identical A/E point estimate
    expect(small.kind).not.toBe(big.kind)       // different verdict
  })

  it("names the unreachable high edge on a high-expected cell", () => {
    const v = cellVerdict(1, 2, 0.83)
    expect(v.text).toContain("高側")
    expect(v.text).toContain("不可達")
  })

  /**
   * When the high edge is unreachable the LOW edge is the only bar the cell can
   * ever clear, so the power check has to fall back to it. Without that
   * fallback a high-expected cell would sit at 資料不足 forever, no matter how
   * many observations it accumulated — which is the same never-rings failure
   * the n>=20 re-trigger had.
   */
  it("still reaches 一致 on a high-expected cell, via the low edge", () => {
    const need = requiredN(0.83, 0.7)!
    const n = need * 3
    const v = cellVerdict(Math.round(0.83 * n), n, 0.83)
    expect(v.kind).toBe("consistent")
  })

  it("reproduces the live 2026-09-09 cells as 資料不足, none of them a finding", () => {
    for (const [h, n, p0] of [[6, 9, 0.52], [6, 13, 0.54], [1, 1, 0.72]]) {
      expect(cellVerdict(h, n, p0).kind).toBe("insufficient")
    }
    expect(cellVerdict(0, 0, 0.83).kind).toBe("empty")
  })
})

/**
 * Coverage maturity — when a still-null horizon becomes a genuine fault.
 * The gate this feeds cried wolf on 2026-09-02 and 2026-09-08; on the first
 * occasion the false alarm was accepted as "data availability" and masked a
 * real defect underneath.
 */
describe("coverageMatureDays", () => {
  it("allows the fill slack the pipeline itself already documents", () => {
    // WINDOW_END_CAL_DAYS exists because the +28d target may need the +33d bar.
    expect(FILL_SLACK_CAL_DAYS).toBe(5)
    expect(coverageMatureDays("d20")).toBe(WINDOW_CAL_DAYS.d20 + FILL_SLACK_CAL_DAYS)
  })

  it("is strictly later than the nominal window for every horizon", () => {
    for (const h of ["d5", "d10", "d20"] as const) {
      expect(coverageMatureDays(h)).toBeGreaterThan(WINDOW_CAL_DAYS[h])
    }
  })

  it("never declares a row overdue before the cron would even look at it", () => {
    // The 5d window closes at +7d but the cron ignores rows younger than 10d,
    // so a 8-day-old empty row is not a fault.
    for (const h of ["d5", "d10", "d20"] as const) {
      expect(coverageMatureDays(h)).toBeGreaterThan(ELIGIBLE_AGE_DAYS)
    }
  })

  it("orders the horizons", () => {
    expect(coverageMatureDays("d5")).toBeLessThan(coverageMatureDays("d10"))
    expect(coverageMatureDays("d10")).toBeLessThan(coverageMatureDays("d20"))
  })

  it("would not have flagged the 29-33 day rows the old flat >28 rule did", () => {
    expect(coverageMatureDays("d20")).toBeGreaterThan(29)
    expect(coverageMatureDays("d20")).toBeGreaterThanOrEqual(33)
  })
})
