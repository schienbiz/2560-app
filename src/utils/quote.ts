import type { MarketAdapter } from "../adapters/interface.js"

/**
 * Never-throwing live quote — the display-layer price source.
 *
 * The OHLCV cache is tuned for the signal layer: settled TW bars stay "fresh"
 * until the next 05:30 UTC so scan-tw always scores that day's close — which
 * means during the entire next TW session (01:00–05:30 UTC) every cached read
 * still ends at YESTERDAY's bar. Signals should see settled closes; a price
 * shown to the user as 現價 should not. Any route that displays a current
 * price must fetch the adapter's live quote (TWSE tick / Kraken ticker /
 * Yahoo v8 meta) and only fall back to the last bar close when this returns
 * null (source down, market closed, network error).
 *
 * Returned as a promise the caller can run IN PARALLEL with the OHLCV read
 * (`Promise.all`) — the quote doesn't depend on the bars, so serializing them
 * just adds a round trip to every 掃描 press.
 */
export async function fetchQuoteSafe(
  adapter: Pick<MarketAdapter, "fetchQuote">,
  symbol: string
): Promise<number | null> {
  if (!adapter.fetchQuote) return null
  return adapter.fetchQuote(symbol).catch(() => null)
}
