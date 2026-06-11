/**
 * Support / Resistance zone detection.
 *
 * Algorithm:
 *   1. Find pivot highs (local maxima) and pivot lows (local minima)
 *      using a rolling window of `window` bars on each side.
 *   2. Cluster pivot prices that are within `tolerance` % of each other
 *      into a single zone (use the average price of the cluster).
 *   3. Return the top N zones sorted by recency (most recent first).
 */

import type { OHLCV } from "./types.js"

export interface SRZones {
  support:    number[]   // price levels below current close
  resistance: number[]   // price levels above current close
}

export function computeSR(
  ohlcv:     OHLCV[],
  window:    number = 5,    // bars on each side to qualify as pivot
  tolerance: number = 0.015, // 1.5% cluster radius
  maxZones:  number = 4,    // max support + resistance zones each
): SRZones {
  if (ohlcv.length < window * 2 + 1) return { support: [], resistance: [] }

  const pivotHighs: number[] = []
  const pivotLows:  number[] = []

  for (let i = window; i < ohlcv.length - window; i++) {
    const bar = ohlcv[i]
    let isPivotHigh = true
    let isPivotLow  = true

    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue
      if (ohlcv[j].high > bar.high) { isPivotHigh = false }
      if (ohlcv[j].low  < bar.low)  { isPivotLow  = false }
      if (!isPivotHigh && !isPivotLow) break
    }

    if (isPivotHigh) pivotHighs.push(bar.high)
    if (isPivotLow)  pivotLows.push(bar.low)
  }

  const currentClose = ohlcv[ohlcv.length - 1].close

  const resistanceLevels = cluster(pivotHighs, tolerance)
    .filter(p => p > currentClose)
    .sort((a, b) => a - b)          // nearest first
    .slice(0, maxZones)

  const supportLevels = cluster(pivotLows, tolerance)
    .filter(p => p < currentClose)
    .sort((a, b) => b - a)          // nearest first
    .slice(0, maxZones)

  return { support: supportLevels, resistance: resistanceLevels }
}

/**
 * Merge prices that are within `tolerance` of each other into one cluster.
 * Returns the mean price of each cluster.
 */
function cluster(prices: number[], tolerance: number): number[] {
  if (!prices.length) return []

  const sorted = [...prices].sort((a, b) => a - b)
  const clusters: number[][] = [[sorted[0]]]

  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1]
    const mean = last.reduce((s, v) => s + v, 0) / last.length
    if (Math.abs(sorted[i] - mean) / mean <= tolerance) {
      last.push(sorted[i])
    } else {
      clusters.push([sorted[i]])
    }
  }

  return clusters.map(c => c.reduce((s, v) => s + v, 0) / c.length)
}
