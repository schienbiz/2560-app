/**
 * Yahoo Finance unofficial adapter — no API key required.
 *
 * DATA FLOW:
 *   fetchOHLCV("2330.TW", 90)
 *     → GET https://query1.finance.yahoo.com/v8/finance/chart/2330.TW
 *         ?interval=1d&range=6mo
 *     → { chart: { result: [{ timestamp[], indicators: { quote: [{ open, high, low, close, volume }] } }] } }
 *     → normalize to OHLCV[]
 *
 * Symbol formats:
 *   Taiwan stocks:  "2330.TW"
 *   US stocks:      "AAPL", "TSLA"
 *   HK stocks:      "0700.HK"
 */

import type { MarketAdapter } from "./interface.js"
import type { OHLCV } from "../engine/types.js"

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart"

function daysToRange(days: number): string {
  if (days <= 5)   return "5d"
  if (days <= 30)  return "1mo"
  if (days <= 90)  return "3mo"
  if (days <= 180) return "6mo"
  if (days <= 365) return "1y"
  return "2y"
}

export class YahooFinanceAdapter implements MarketAdapter {
  getAssetType() { return "stock" as const }

  async validateSymbol(symbol: string): Promise<boolean> {
    try {
      const res = await fetch(`${BASE}/${encodeURIComponent(symbol)}?interval=1d&range=5d`, {
        headers: { "User-Agent": "Mozilla/5.0" },
      })
      if (!res.ok) return false
      const json = await res.json() as YahooResponse
      return !!json.chart?.result?.[0]
    } catch {
      return false
    }
  }

  async fetchOHLCV(symbol: string, days: number): Promise<OHLCV[]> {
    const range = daysToRange(days)
    const url = `${BASE}/${encodeURIComponent(symbol)}?interval=1d&range=${range}`
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
    if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status} ${symbol}`)

    const json = await res.json() as YahooResponse
    const result = json.chart?.result?.[0]
    if (!result) throw new Error(`No data for symbol: ${symbol}`)

    const { timestamp, indicators } = result
    const quote = indicators.quote[0]

    return timestamp
      .map((ts, i) => ({
        date:   new Date(ts * 1000).toISOString().slice(0, 10),
        open:   quote.open[i]   ?? 0,
        high:   quote.high[i]   ?? 0,
        low:    quote.low[i]    ?? 0,
        close:  quote.close[i]  ?? 0,
        volume: quote.volume[i] ?? 0,
      }))
      .filter(b => b.close > 0)   // drop null bars (holidays, missing data)
      .slice(-days)                // trim to requested days
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface YahooResponse {
  chart: {
    result?: Array<{
      timestamp: number[]
      indicators: {
        quote: Array<{
          open:   (number | null)[]
          high:   (number | null)[]
          low:    (number | null)[]
          close:  (number | null)[]
          volume: (number | null)[]
        }>
      }
    }>
  }
}
