/**
 * Pure window-return math for cron/outcome.ts — no db imports, so vitest can
 * exercise the date logic without a Prisma client.
 *
 * Calendar-day approximations of trading-day horizons (+5→7, +10→14, +20→28
 * calendar days, price = first bar on/after the target) are carried over
 * unchanged from the original outcome cron so recomputed rows stay comparable
 * with previously stored outcomes.
 */

export interface PriceBar { date: Date; close: number }
export interface WindowReturns { d5: number | null; d10: number | null; d20: number | null }

export const WINDOW_CAL_DAYS = { d5: 7, d10: 14, d20: 28 } as const
/** Query span past the signal so a weekend/holiday after the +28d target still finds a bar. */
export const WINDOW_END_CAL_DAYS = 33
/** A benchmark base bar lagging the signal date by more than this is a cache gap, not a holiday. */
export const BENCHMARK_BASE_MAX_LAG_DAYS = 5

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}

export function firstCloseOnOrAfter(rows: PriceBar[], target: Date): number | null {
  return rows.find(r => r.date >= target)?.close ?? null
}

/** % change from `base` to the first close on/after each horizon target. */
export function windowReturns(rows: PriceBar[], base: number, signalDate: Date): WindowReturns {
  const pct = (p: number | null): number | null =>
    p != null ? ((p - base) / base) * 100 : null
  return {
    d5:  pct(firstCloseOnOrAfter(rows, addDays(signalDate, WINDOW_CAL_DAYS.d5))),
    d10: pct(firstCloseOnOrAfter(rows, addDays(signalDate, WINDOW_CAL_DAYS.d10))),
    d20: pct(firstCloseOnOrAfter(rows, addDays(signalDate, WINDOW_CAL_DAYS.d20))),
  }
}

/**
 * Benchmark base = the index close at (or first trading day after) the signal
 * date. Null when the earliest available index bar lags the signal date by
 * more than BENCHMARK_BASE_MAX_LAG_DAYS — measuring the index from a much
 * later base would misstate the regime move over the window.
 * `rows` must already be filtered to date ≥ signalDate, ascending.
 */
export function benchmarkBase(rows: PriceBar[], signalDate: Date): number | null {
  const first = rows[0]
  if (!first) return null
  if (first.date > addDays(signalDate, BENCHMARK_BASE_MAX_LAG_DAYS)) return null
  return first.close
}
