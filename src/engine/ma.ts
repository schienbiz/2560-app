/**
 * Moving average calculation.
 *
 * DATA FLOW:
 *   prices[] ──► computeMA(n) ──► (number | null)[]
 *
 * First (period - 1) values are null — not enough history yet.
 * All functions are pure: no DB, no side effects.
 */

/**
 * Simple Moving Average over a closing price series.
 * Returns null for indices where fewer than `period` prices exist.
 */
export function computeMA(prices: number[], period: number): (number | null)[] {
  return prices.map((_, i) => {
    if (i < period - 1) return null
    const slice = prices.slice(i - period + 1, i + 1)
    return slice.reduce((sum, p) => sum + p, 0) / period
  })
}

/**
 * Extract the last N non-null values from an MA series.
 * Used to check recent cross conditions.
 */
export function lastN(series: (number | null)[], n: number): number[] {
  const values = series.filter((v): v is number => v !== null)
  return values.slice(-n)
}
