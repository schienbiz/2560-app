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
    // Accept any symbol that looks reasonable (letters, digits, dots, hyphens)
    // Avoids an external API call that may be blocked or rate-limited on some hosting environments
    return /^[A-Z0-9.\-]{1,20}$/.test(symbol.toUpperCase())
  }

  async fetchOHLCV(symbol: string, days: number): Promise<OHLCV[]> {
    // 4-digit Taiwan stock shorthand — try TWSE (.TW) then OTC (.TWO)
    if (/^\d{4}$/.test(symbol)) {
      for (const suffix of [".TW", ".TWO"]) {
        const bars = await this._tryFetch(symbol + suffix, days)
        if (bars) return bars
      }
      throw new Error(`No data for symbol: ${symbol}`)
    }

    const bars = await this._tryFetch(symbol, days)
    if (bars) return bars

    // Stored as .TW but actually OTC — try .TWO fallback (handles legacy DB entries)
    if (symbol.toUpperCase().endsWith(".TW")) {
      const twoData = await this._tryFetch(symbol.slice(0, -3) + ".TWO", days)
      if (twoData) return twoData
    }

    throw new Error(`No data for symbol: ${symbol}`)
  }

  private async _tryFetch(symbol: string, days: number): Promise<OHLCV[] | null> {
    const range = daysToRange(days)
    const url = `${BASE}/${encodeURIComponent(symbol)}?interval=1d&range=${range}`
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
    if (!res.ok) return null

    const json = await res.json() as YahooResponse
    const result = json.chart?.result?.[0]
    if (!result) return null

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
