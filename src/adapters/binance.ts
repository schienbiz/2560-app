/**
 * Crypto OHLCV adapter using CryptoCompare public API.
 *
 * DATA FLOW:
 *   fetchOHLCV("BTCUSDT", 90)
 *     → splits "BTCUSDT" → fsym=BTC, tsym=USDT
 *     → GET https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USDT&limit=90
 *     → { Data: { Data: [ { time, open, high, low, close, volumefrom } ] } }
 *     → normalize to OHLCV[]
 *
 * No API key required for free tier (100k calls/month).
 */

import type { MarketAdapter } from "./interface.js"
import type { OHLCV } from "../engine/types.js"

const BASE = "https://min-api.cryptocompare.com/data/v2"

// Split "BTCUSDT" → { fsym: "BTC", tsym: "USDT" }
// Handles USDT, BTC, ETH, USDC quote currencies
function splitPair(symbol: string): { fsym: string; tsym: string } {
  const upper = symbol.toUpperCase()
  for (const quote of ["USDT", "USDC", "BTC", "ETH", "BNB"]) {
    if (upper.endsWith(quote)) {
      return { fsym: upper.slice(0, -quote.length), tsym: quote }
    }
  }
  // Fallback: assume last 4 chars are quote
  return { fsym: upper.slice(0, -4), tsym: upper.slice(-4) }
}

export class BinanceAdapter implements MarketAdapter {
  getAssetType() { return "crypto" as const }

  async validateSymbol(symbol: string): Promise<boolean> {
    return /^[A-Z0-9]{3,20}$/.test(symbol.toUpperCase())
  }

  async fetchOHLCV(symbol: string, days: number): Promise<OHLCV[]> {
    const { fsym, tsym } = splitPair(symbol)
    const limit = Math.min(days, 2000)
    const url = `${BASE}/histoday?fsym=${fsym}&tsym=${tsym}&limit=${limit}`

    const res = await fetch(url)
    if (!res.ok) throw new Error(`CryptoCompare fetch failed: ${res.status} ${symbol}`)

    const json = await res.json() as CryptoCompareResponse
    if (json.Response !== "Success") throw new Error(`CryptoCompare error: ${json.Message ?? symbol}`)

    return json.Data.Data.map(k => ({
      date:   new Date(k.time * 1000).toISOString().slice(0, 10),
      open:   k.open,
      high:   k.high,
      low:    k.low,
      close:  k.close,
      volume: k.volumefrom,
    })).filter(b => b.close > 0)
  }
}

interface CryptoCompareResponse {
  Response: string
  Message?: string
  Data: {
    Data: Array<{
      time:       number
      open:       number
      high:       number
      low:        number
      close:      number
      volumefrom: number
    }>
  }
}
