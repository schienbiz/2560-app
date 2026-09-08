import { BinanceAdapter, isCryptoSymbol } from "./binance.js"
import { YahooFinanceAdapter } from "./yahoo.js"
import type { MarketAdapter } from "./interface.js"

const binance = new BinanceAdapter()
const yahoo   = new YahooFinanceAdapter()

/**
 * Route a symbol string to the correct adapter.
 *
 * ROUTING RULES:
 *   Exact crypto pair (…USDT or a mapped pair) → Kraken (crypto)
 *   Everything else                            → Yahoo (stock)
 *
 * `normalizedSymbol` is only upper-cased/trimmed — it is NOT the canonical
 * exchange symbol. A bare Taiwan code ("2330") stays "2330" here because
 * choosing between .TW and .TWO requires a network probe, which this
 * synchronous router cannot do. Anything that PERSISTS a symbol (watchlist,
 * reminders, trades, cache keys, signal history) must go through
 * `resolveSymbol()` in utils/symbol.ts first; see the note there for what the
 * un-canonicalised form cost in production.
 */
export function getAdapter(symbol: string): { adapter: MarketAdapter; normalizedSymbol: string } {
  const upper = symbol.toUpperCase().trim()

  if (isCryptoSymbol(upper)) {
    return { adapter: binance, normalizedSymbol: upper }
  }

  return { adapter: yahoo, normalizedSymbol: upper }
}

export { BinanceAdapter, YahooFinanceAdapter }
export type { MarketAdapter }
