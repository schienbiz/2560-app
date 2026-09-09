/**
 * Binomial statistics for the A/E experience report — pure, no db.
 *
 * WHY THIS EXISTS (2026-09-09 Phase 1 pull):
 * `scripts/ae-report.ts` gated its verdict on a flat `n >= 20`, which is
 * under-powered for every cell it reports on. Measured: to push an A/E of 1.30
 * — the script's OWN band edge, the point at which it prints ⚠️出界 — outside a
 * 95% Wilson interval takes n≈35 for a cell whose expected is ~0.5. At n=20 the
 * interval still spans the entire band, so the old rule printed `A/E=x.xx ✓`
 * at a sample size where ✓ and ⚠️ were not yet distinguishable. A verdict you
 * cannot support is worse than 資料不足, because it reads as a finding.
 *
 * Worse, for `death 5/5` the band's high edge is unreachable by arithmetic:
 * expected 0.83 × 1.30 = 1.079 > 1. No sample of any size can breach it. A
 * symmetric ±30% band simply does not apply to a cell with a high expected —
 * only the low edge (0.83 × 0.7 = 0.581) is ever testable.
 *
 * So the verdict is derived from whether the interval actually excludes the
 * expected, and "how much more data" is reported as a number instead of being
 * left for the reader to guess.
 */

/** z for a two-sided 95% interval. */
export const Z_95 = 1.96

/**
 * Two-sided Wilson score interval for a binomial proportion.
 *
 * Wilson rather than normal-approximation because every cell here is
 * small-n and often at an extreme (1/1, 0/0): the normal interval produces
 * nonsense like [100%, 100%] or negative bounds exactly where this report
 * lives.
 *
 * n = 0 returns [0, 1] — no observations, so nothing is excluded. That is the
 * honest answer and it makes `excludes()` false for every expected, which is
 * what keeps an empty cell from ever reading as a finding.
 */
export function wilsonInterval(hits: number, n: number, z: number = Z_95): [number, number] {
  // Delegates the n<=0 case too, so the guard lives in exactly one place.
  // Keeping a second copy here left the one in wilsonIntervalFromRate
  // unreachable — dead code that no test could ever hold to account.
  if (n <= 0) return wilsonIntervalFromRate(0, n, z)
  return wilsonIntervalFromRate(hits / n, n, z)
}

/**
 * Same interval, taken from an observed RATE rather than an integer count.
 *
 * requiredN() needs this. Asking "what if the true rate were exactly p0×ae"
 * with an integer count forces a rounding step, and that rounding is not
 * monotone in n: for p0=0.83 at the low band edge (rate 0.581), n=6 excludes
 * 0.83 but n=7, 8 and 10 do not, purely because round(0.581·n) lands on a
 * luckier proportion at 6. Quoting "需 n≈6" would then be an artefact that
 * evaporates on the seventh observation. Using the exact rate makes the
 * interval shrink monotonically, so the answer is a real sample-size floor.
 */
export function wilsonIntervalFromRate(rate: number, n: number, z: number = Z_95): [number, number] {
  if (n <= 0) return [0, 1]
  const denom = 1 + (z * z) / n
  const centre = (rate + (z * z) / (2 * n)) / denom
  const margin = (z * Math.sqrt((rate * (1 - rate) + (z * z) / (4 * n)) / n)) / denom
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

/** Lower bound only — the column the report has always printed. */
export function wilsonLB(hits: number, n: number, z: number = Z_95): number {
  return wilsonInterval(hits, n, z)[0]
}

/** Does the interval exclude `p0`? This is the only honest test of "drifting". */
export function excludes(hits: number, n: number, p0: number, z: number = Z_95): boolean {
  const [lo, hi] = wilsonInterval(hits, n, z)
  return p0 < lo || p0 > hi
}

/**
 * Smallest n at which observing a rate of exactly `p0 * ae` would exclude `p0`.
 *
 * Returns null when the target rate is not a probability (p0 * ae > 1) — that
 * is the `death 5/5` case, and null means "no sample size will ever do it",
 * not "we did not look hard enough".
 *
 * Measured by walking n against the same Wilson formula the report gates on,
 * rather than inverting the algebra separately — that is how a quoted number
 * and the actual gate drift apart. It uses the exact rate rather than a rounded
 * count, so the result is monotone; see wilsonIntervalFromRate.
 */
export function requiredN(p0: number, ae: number, maxN = 20_000, z: number = Z_95): number | null {
  const target = p0 * ae
  if (target > 1 || target < 0) return null
  for (let n = 1; n <= maxN; n++) {
    const [lo, hi] = wilsonIntervalFromRate(target, n, z)
    if (p0 < lo || p0 > hi) return n
  }
  return null
}

export interface PowerReport {
  /** n needed to detect the high band edge; null = arithmetically unreachable. */
  highN: number | null
  /** n needed to detect the low band edge. */
  lowN: number | null
}

/**
 * How much data before this cell can say anything at either band edge.
 * `highN: null` is the signal that a symmetric band does not fit this cell.
 */
export function powerReport(p0: number, bandLo: number, bandHi: number): PowerReport {
  return { highN: requiredN(p0, bandHi), lowN: requiredN(p0, bandLo) }
}

export type VerdictKind = "empty" | "drifting" | "consistent" | "insufficient"

export interface CellVerdict {
  kind: VerdictKind
  /** Observed / expected, or null when n = 0. */
  ae: number | null
  interval: [number, number]
  text: string
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`

/**
 * Verdict for one cell, power-aware.
 *
 *   drifting     — the interval excludes the expected. The only state that is
 *                  actually a finding.
 *   consistent   — covers the expected AND n is already big enough to have
 *                  detected a band-edge deviation. Real agreement.
 *   insufficient — covers the expected but n is too small to distinguish.
 *                  Reports the n that would be needed.
 *   empty        — no observations at all.
 */
export function cellVerdict(
  hits: number,
  n: number,
  p0: number,
  bandLo = 0.7,
  bandHi = 1.3,
): CellVerdict {
  const interval = wilsonInterval(hits, n)
  if (n === 0) {
    return { kind: "empty", ae: null, interval, text: "無觀測（n=0）" }
  }

  const ae = hits / n / p0
  const ci = `[${pct(interval[0])}, ${pct(interval[1])}]`

  if (excludes(hits, n, p0)) {
    return { kind: "drifting", ae, interval, text: `⚠️ 偏離：A/E=${ae.toFixed(2)}，95%區間${ci} 排除期望 ${pct(p0)}` }
  }

  const { highN, lowN } = powerReport(p0, bandLo, bandHi)
  // The cell is only "big enough" once it could have caught a deviation at an
  // edge that is actually reachable. When the high edge is unreachable the low
  // edge is the only bar this cell can ever clear.
  const need = highN ?? lowN
  if (need != null && n >= need) {
    return { kind: "consistent", ae, interval, text: `✓ 與期望一致：A/E=${ae.toFixed(2)}，區間${ci} 涵蓋 ${pct(p0)}（n=${n} 已足以偵測帶邊）` }
  }

  const unreachable = highN == null ? `；高側 A/E=${bandHi} 不可達（${pct(p0)}×${bandHi}>100%）` : ""
  const needTxt = need == null ? "任何 n 皆無法偵測" : `需 n≈${need}`
  return {
    kind: "insufficient",
    ae,
    interval,
    text: `資料不足：A/E=${ae.toFixed(2)}，區間${ci} 涵蓋 ${pct(p0)}（n=${n}，${needTxt}）${unreachable}`,
  }
}
