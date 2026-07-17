import type { MarketAdapter } from "../adapters/interface.js"

/**
 * Live price with settled-bar fallback — the display-layer overlay.
 *
 * The OHLCV cache is tuned for the signal layer: settled TW bars stay "fresh"
 * until the next 05:30 UTC so scan-tw always scores that day's close — which
 * means during the entire next TW session (01:00–05:30 UTC) every cached read
 * still ends at YESTERDAY's bar. Signals should see settled closes; a price
 * shown to the user as 現價 should not. Any route that displays a current
 * price must overlay the adapter's live quote (TWSE tick / Kraken ticker /
 * Yahoo v8 meta) and only fall back to the last bar close when the quote is
 * unavailable (source down, network error).
 */
export async function liveClose(
  adapter: Pick<MarketAdapter, "fetchQuote">,
  symbol: string,
  lastBarClose: number | null
): Promise<number | null> {
  if (adapter.fetchQuote) {
    const q = await adapter.fetchQuote(symbol).catch(() => null)
    if (q !== null) return q
  }
  return lastBarClose
}
