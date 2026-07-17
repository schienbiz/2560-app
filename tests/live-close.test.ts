/**
 * liveClose overlay — the display-layer price rule.
 *
 * Regression anchor: /api/scan returned the cached bar close as 現價. During
 * TW market hours the settled-day cache (fresh until 05:30 UTC for scan-tw)
 * still ends at YESTERDAY's bar, so the scan showed the previous session's
 * close while brokerage apps showed the live tick (2026-07-17: cached 2470 vs
 * live 2370 on 2330.TW). Display paths must overlay the live quote and only
 * fall back to the bar close when the quote is unavailable.
 */

import { describe, it, expect, vi } from "vitest"
import { liveClose } from "../src/utils/quote.js"

describe("liveClose", () => {
  it("prefers the live quote over the cached bar close", async () => {
    const adapter = { fetchQuote: vi.fn(async () => 2370) }
    expect(await liveClose(adapter, "2330.TW", 2470)).toBe(2370)
  })

  it("falls back to the bar close when the quote is null (market closed)", async () => {
    const adapter = { fetchQuote: vi.fn(async () => null) }
    expect(await liveClose(adapter, "2330.TW", 2470)).toBe(2470)
  })

  it("falls back to the bar close when the quote throws", async () => {
    const adapter = { fetchQuote: vi.fn(async () => { throw new Error("timeout") }) }
    expect(await liveClose(adapter, "2330.TW", 2470)).toBe(2470)
  })

  it("falls back when the adapter has no fetchQuote", async () => {
    expect(await liveClose({} as never, "2330.TW", 2470)).toBe(2470)
  })

  it("returns null when both quote and bar close are unavailable", async () => {
    const adapter = { fetchQuote: vi.fn(async () => null) }
    expect(await liveClose(adapter, "2330.TW", null)).toBeNull()
  })
})
