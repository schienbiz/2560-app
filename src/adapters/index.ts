import { BinanceAdapter } from "./binance.js"
import { YahooFinanceAdapter } from "./yahoo.js"
import type { MarketAdapter } from "./interface.js"

const binance = new BinanceAdapter()
const yahoo   = new YahooFinanceAdapter()

/**
 * Route a symbol string to the correct adapter.
 *
 * ROUTING RULES:
 *   Contains "USDT" or "BTC" or "ETH" → Binance (crypto)
 *   Contains "."  (e.g. "2330.TW")    → Yahoo (stock with exchange suffix)
 *   Pure digits 4 chars               → Yahoo (Taiwan stock shorthand → append .TW)
 *   Otherwise                         → Yahoo (US stock, e.g. "AAPL")
 */
export function getAdapter(symbol: string): { adapter: MarketAdapter; normalizedSymbol: string } {
  const upper = symbol.toUpperCase().trim()

  if (upper.endsWith("USDT") || /^(BTC|ETH|BNB|SOL|XRP|DOGE|ADA|AVAX|DOT|MATIC|LINK|LTC)/.test(upper)) {
    return { adapter: binance, normalizedSymbol: upper }
  }

  return { adapter: yahoo, normalizedSymbol: upper }
}

export { BinanceAdapter, YahooFinanceAdapter }
export type { MarketAdapter }
