/**
 * Binance public REST adapter — no API key required.
 *
 * DATA FLOW:
 *   fetchOHLCV("BTCUSDT", 90)
 *     → GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=90
 *     → [ [openTime, open, high, low, close, volume, ...], ... ]
 *     → normalize to OHLCV[]
 */

import type { MarketAdapter } from "./interface.js"
import type { OHLCV } from "../engine/types.js"

const BASE = "https://api.binance.com"

export class BinanceAdapter implements MarketAdapter {
  getAssetType() { return "crypto" as const }

  async validateSymbol(symbol: string): Promise<boolean> {
    // Accept any symbol that looks like a valid crypto pair (letters + digits, 3-20 chars)
    // Avoids an external API call that may be blocked on some hosting environments
    return /^[A-Z0-9]{3,20}$/.test(symbol.toUpperCase())
  }

  async fetchOHLCV(symbol: string, days: number): Promise<OHLCV[]> {
    const limit = Math.min(days, 1000)  // Binance max is 1000 per request
    const url = `${BASE}/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=1d&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Binance fetch failed: ${res.status} ${symbol}`)

    const raw = await res.json() as [number, string, string, string, string, string, ...unknown[]][]
    return raw.map(k => ({
      date:   new Date(k[0]).toISOString().slice(0, 10),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }))
  }
}
