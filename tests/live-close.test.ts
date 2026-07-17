/**
 * fetchQuoteSafe — the display-layer live-price source.
 *
 * Regression anchor: /api/scan returned the cached bar close as 現價. During
 * TW market hours the settled-day cache (fresh until 05:30 UTC for scan-tw)
 * still ends at YESTERDAY's bar, so the scan showed the previous session's
 * close while brokerage apps showed the live tick (2026-07-17: cached 2470 vs
 * live 2370 on 2330.TW). Display paths fetch the live quote (in parallel with
 * the OHLCV read) and fall back to the bar close only when it returns null.
 */

import { describe, it, expect, vi } from "vitest"
import { fetchQuoteSafe } from "../src/utils/quote.js"

describe("fetchQuoteSafe", () => {
  it("returns the live quote", async () => {
    const adapter = { fetchQuote: vi.fn(async () => 2370) }
    expect(await fetchQuoteSafe(adapter, "2330.TW")).toBe(2370)
  })

  it("returns null when the quote is unavailable (market closed)", async () => {
    const adapter = { fetchQuote: vi.fn(async () => null) }
    expect(await fetchQuoteSafe(adapter, "2330.TW")).toBeNull()
  })

  it("never throws — a quote error becomes null", async () => {
    const adapter = { fetchQuote: vi.fn(async () => { throw new Error("timeout") }) }
    expect(await fetchQuoteSafe(adapter, "2330.TW")).toBeNull()
  })

  it("returns null when the adapter has no fetchQuote", async () => {
    expect(await fetchQuoteSafe({} as never, "2330.TW")).toBeNull()
  })
})
