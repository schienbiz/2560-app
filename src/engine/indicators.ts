/**
 * Technical indicators: EMA, RSI(14), MACD(12/26/9).
 * All functions are pure: no DB, no side effects.
 * Arrays are index-aligned to the input price series; indices without
 * enough history are null.
 */

/**
 * Exponential Moving Average.
 * Seed = SMA of the first `period` prices; k = 2 / (period + 1).
 */
export function computeEMA(prices: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(prices.length).fill(null)
  if (prices.length < period) return result

  const k = 2 / (period + 1)
  result[period - 1] = prices.slice(0, period).reduce((s, p) => s + p, 0) / period

  for (let i = period; i < prices.length; i++) {
    result[i] = prices[i] * k + (result[i - 1] as number) * (1 - k)
  }
  return result
}

/**
 * RSI using Wilder's smoothing.
 * First valid value appears at index `period` (seeds from bars 1..period).
 */
export function computeRSI(prices: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(prices.length).fill(null)
  if (prices.length < period + 1) return result

  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1]
    if (d > 0) avgGain += d
    else avgLoss += -d
  }
  avgGain /= period
  avgLoss /= period

  const toRsi = (ag: number, al: number) =>
    al === 0 ? 100 : 100 - 100 / (1 + ag / al)

  result[period] = toRsi(avgGain, avgLoss)

  for (let i = period + 1; i < prices.length; i++) {
    const d    = prices[i] - prices[i - 1]
    const gain = d > 0 ? d : 0
    const loss = d < 0 ? -d : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result[i] = toRsi(avgGain, avgLoss)
  }
  return result
}

export interface MACDSeries {
  macd:      (number | null)[]
  signal:    (number | null)[]
  histogram: (number | null)[]
}

/**
 * MACD(fast, slow, signalPeriod) — standard 12/26/9.
 * MACD line = EMA(fast) − EMA(slow)
 * Signal    = EMA(signalPeriod) of MACD line
 * Histogram = MACD − Signal
 */
export function computeMACD(
  prices:        number[],
  fastPeriod   = 12,
  slowPeriod   = 26,
  signalPeriod = 9
): MACDSeries {
  const emaFast = computeEMA(prices, fastPeriod)
  const emaSlow = computeEMA(prices, slowPeriod)

  const macdLine: (number | null)[] = prices.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null
      ? (emaFast[i] as number) - (emaSlow[i] as number)
      : null
  )

  // Build EMA of the MACD values (only the contiguous non-null run)
  const firstValid  = macdLine.findIndex(v => v != null)
  const macdValues  = macdLine.filter((v): v is number => v != null)
  const sigLine: (number | null)[] = new Array(prices.length).fill(null)

  if (firstValid >= 0 && macdValues.length >= signalPeriod) {
    const sigEMA = computeEMA(macdValues, signalPeriod)
    for (let i = 0; i < sigEMA.length; i++) {
      if (sigEMA[i] != null) sigLine[firstValid + i] = sigEMA[i]
    }
  }

  const histogram: (number | null)[] = prices.map((_, i) =>
    macdLine[i] != null && sigLine[i] != null
      ? (macdLine[i] as number) - (sigLine[i] as number)
      : null
  )

  return { macd: macdLine, signal: sigLine, histogram }
}
