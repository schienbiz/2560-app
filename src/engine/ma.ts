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
 * Sliding window O(N) — avoids the O(N×period) cost of repeated slice+reduce.
 */
export function computeMA(prices: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(prices.length).fill(null)
  if (prices.length < period) return result

  let sum = 0
  for (let i = 0; i < period; i++) sum += prices[i]
  result[period - 1] = sum / period

  for (let i = period; i < prices.length; i++) {
    sum += prices[i] - prices[i - period]
    result[i] = sum / period
  }
  return result
}

/**
 * Extract the last N non-null values from an MA series.
 * Used to check recent cross conditions.
 */
export function lastN(series: (number | null)[], n: number): number[] {
  const values = series.filter((v): v is number => v !== null)
  return values.slice(-n)
}

/**
 * Return the last non-null value in a series without allocating a copy.
 * Replaces the [...series].reverse().find(v => v != null) pattern.
 */
export function lastNonNull(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i] as number
  }
  return null
}
