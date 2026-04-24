/**
 * Crypto OHLCV adapter using Kraken public REST API.
 *
 * DATA FLOW:
 *   fetchOHLCV("BTCUSDT", 90)
 *     → maps "BTCUSDT" → Kraken pair "XBTUSD"
 *     → GET https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440
 *     → { result: { XXBTZUSD: [ [time, open, high, low, close, vwap, volume, count] ] } }
 *     → normalize to OHLCV[]
 *
 *   fetchQuote("BTCUSDT")
 *     → GET https://api.kraken.com/0/public/Ticker?pair=XBTUSD
 *     → last trade price from result[pair].c[0]
 *
 * No API key required. No rate limit for public endpoints.
 */

import type { MarketAdapter } from "./interface.js"
import type { OHLCV } from "../engine/types.js"

const BASE = "https://api.kraken.com/0/public"

// Map common USDT/USD pairs to Kraken pair names
// Kraken uses XBT for Bitcoin and USD instead of USDT
const PAIR_MAP: Record<string, string> = {
  BTCUSDT:  "XBTUSD",
  BTCUSD:   "XBTUSD",
  ETHUSDT:  "ETHUSD",
  ETHUSD:   "ETHUSD",
  SOLUSDT:  "SOLUSD",
  XRPUSDT:  "XRPUSD",
  DOGEUSDT: "DOGEUSD",
  BNBUSDT:  "BNBUSD",
  ADAUSDT:  "ADAUSD",
  AVAXUSDT: "AVAXUSD",
  DOTUSDT:  "DOTUSD",
  MATICUSDT:"MATICUSD",
  LINKUSDT: "LINKUSD",
  LTCUSDT:  "LTCUSD",
}

function toKrakenPair(symbol: string): string {
  const upper = symbol.toUpperCase()
  return PAIR_MAP[upper] ?? upper
}

export class BinanceAdapter implements MarketAdapter {
  getAssetType() { return "crypto" as const }

  async validateSymbol(symbol: string): Promise<boolean> {
    return /^[A-Z0-9]{3,20}$/.test(symbol.toUpperCase())
  }

  async fetchQuote(symbol: string): Promise<number | null> {
    const pair = toKrakenPair(symbol)
    try {
      const url = `${BASE}/Ticker?pair=${pair}`
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) return null
      const json = await res.json() as KrakenTickerResponse
      if (json.error?.length) return null
      const data = Object.values(json.result)[0]
      const price = parseFloat(data.c[0])
      return isNaN(price) ? null : price
    } catch {
      return null
    }
  }

  async fetchOHLCV(symbol: string, days: number): Promise<OHLCV[]> {
    const pair = toKrakenPair(symbol)
    // interval=1440 = daily candles; since = unix timestamp for 'days' ago
    const since = Math.floor(Date.now() / 1000) - days * 86400
    const url = `${BASE}/OHLC?pair=${pair}&interval=1440&since=${since}`

    const res = await fetch(url)
    if (!res.ok) throw new Error(`Kraken fetch failed: ${res.status} ${symbol}`)

    const json = await res.json() as KrakenResponse
    if (json.error?.length) throw new Error(`Kraken error: ${json.error.join(", ")}`)

    // Result has one key (the pair name), ignore the "last" key
    const resultKey = Object.keys(json.result).find(k => k !== "last")
    if (!resultKey) throw new Error(`No data for symbol: ${symbol}`)

    const rows = json.result[resultKey] as KrakenOHLCRow[]
    return rows
      .map(k => ({
        date:   new Date(k[0] * 1000).toISOString().slice(0, 10),
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[6]),
      }))
      .filter(b => b.close > 0)
      .slice(-days)
  }
}

// [time, open, high, low, close, vwap, volume, count]
type KrakenOHLCRow = [number, string, string, string, string, string, string, number]

interface KrakenResponse {
  error: string[]
  result: Record<string, KrakenOHLCRow[] | number>
}

interface KrakenTickerResponse {
  error: string[]
  result: Record<string, {
    c: [string, string]  // [last trade price, lot volume]
  }>
}
