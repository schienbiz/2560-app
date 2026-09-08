/**
 * Canonical symbol resolution.
 *
 * Production evidence this exists for (2026-09-07):
 *   - OhlcvCache held "2330" (503 bars) AND "2330.TW" (503 bars) with all 503
 *     closes identical; SignalHistory recorded every 2330 event twice, so the
 *     win-rate stats counted one stock as two; one user held both "5230" and
 *     "5230.TW" and got two pushes for one cross.
 *   - The suffix that was stored could be wrong outright: probing Yahoo shows
 *     5230, 8937 and 3176 list on TPEx (.TWO — their .TW answers 404) while the
 *     watchlist held "5230.TW" and "8937.TW".
 */

import { describe, it, expect, beforeEach } from "vitest"
import { resolveSymbol, resolveSymbolForRead, resolveTwSuffix, clearSymbolMemo } from "../src/utils/symbol.js"
import { getAdapter } from "../src/adapters/index.js"

/** Probe stub: `listed` are found, `unknown` answer null (could not tell). */
const probeOf = (listed: string[], unknown: string[] = []) => {
  const calls: string[] = []
  const fn = async (s: string) => {
    calls.push(s)
    if (unknown.includes(s)) return null
    return listed.includes(s)
  }
  return { fn, calls }
}

describe("resolveTwSuffix", () => {
  it("resolves a TWSE-listed code to .TW", async () => {
    const p = probeOf(["2330.TW"])
    expect(await resolveTwSuffix("2330", p.fn)).toEqual({ symbol: "2330.TW", resolved: true })
  })

  it("resolves an OTC code to .TWO — the case the old code got wrong", async () => {
    const p = probeOf(["5230.TWO"])
    expect(await resolveTwSuffix("5230", p.fn)).toEqual({ symbol: "5230.TWO", resolved: true })
    expect(p.calls).toEqual(["5230.TW", "5230.TWO"])   // TWSE first, then TPEx
  })

  it("does not probe TPEx once TWSE has confirmed — one round trip for most codes", async () => {
    const p = probeOf(["2330.TW"])
    await resolveTwSuffix("2330", p.fn)
    expect(p.calls).toEqual(["2330.TW"])
  })

  it("an INCONCLUSIVE .TW probe never becomes an OTC verdict", async () => {
    // A rate-limited .TW request must not be read as "not listed on TWSE", or a
    // throttled moment would permanently file a TWSE stock as OTC.
    const p = probeOf(["2330.TWO"], ["2330.TW"])
    const r = await resolveTwSuffix("2330", p.fn)
    expect(r.resolved).toBe(false)
  })

  it("reports unresolved when neither exchange has the code", async () => {
    const p = probeOf([])
    const r = await resolveTwSuffix("9999", p.fn)
    expect(r.resolved).toBe(false)
  })
})

describe("resolveSymbol", () => {
  beforeEach(() => clearSymbolMemo())

  it("collapses the bare code and the suffixed spelling onto ONE symbol", async () => {
    const p = probeOf(["2330.TW"])
    const bare     = await resolveSymbol("2330", p.fn)
    const suffixed = await resolveSymbol("2330.TW", p.fn)
    expect(bare.symbol).toBe("2330.TW")
    expect(suffixed.symbol).toBe("2330.TW")
    expect(bare.symbol).toBe(suffixed.symbol)
  })

  it("corrects a wrong stored suffix: 5230.TW is really 5230.TWO", async () => {
    const p = probeOf(["5230.TWO"])
    expect((await resolveSymbol("5230.TW", p.fn)).symbol).toBe("5230.TWO")
    expect((await resolveSymbol("5230", p.fn)).symbol).toBe("5230.TWO")
  })

  it("leaves US tickers and crypto pairs alone, without probing", async () => {
    const p = probeOf([])
    expect(await resolveSymbol("AAPL", p.fn)).toEqual({ symbol: "AAPL", assetType: "stock", resolved: true })
    expect(await resolveSymbol("btcusdt", p.fn)).toEqual({ symbol: "BTCUSDT", assetType: "crypto", resolved: true })
    expect(p.calls).toEqual([])
  })

  it("memoises a successful resolution — an exchange listing does not move", async () => {
    const p = probeOf(["3176.TWO"])
    await resolveSymbol("3176", p.fn)
    await resolveSymbol("3176", p.fn)
    expect(p.calls).toEqual(["3176.TW", "3176.TWO"])   // second call hit the memo
  })

  it("does NOT memoise a failure, so an outage cannot pin a wrong answer", async () => {
    const p = probeOf([], ["4444.TW", "4444.TWO"])
    expect((await resolveSymbol("4444", p.fn)).resolved).toBe(false)
    await resolveSymbol("4444", p.fn)
    // Probed again rather than served from the memo — and only .TW each time,
    // because an inconclusive TWSE answer short-circuits before TPEx.
    expect(p.calls).toEqual(["4444.TW", "4444.TW"])
  })
})

/**
 * The read paths (public chart / backtest / AI routes) take the symbol from the
 * URL and then use it as the OhlcvCache key. Reproduced against production on
 * 2026-09-08: one `GET /api/chart/2330` recreated 66 cache rows under the bare
 * key, hours after the migration had merged them into `2330.TW`. Every
 * notification sent before v1.7.0 carries a `?symbol=2330` deep link and those
 * messages are still in the user's chat history, so this is a live path.
 */
describe("resolveSymbolForRead", () => {
  beforeEach(() => clearSymbolMemo())

  it("canonicalises a bare code so a URL cannot recreate the alias", async () => {
    const p = probeOf(["2330.TW"])
    expect(await resolveSymbolForRead("2330", p.fn)).toEqual({ symbol: "2330.TW", assetType: "stock" })
  })

  it("corrects a wrong suffix arriving from a URL", async () => {
    const p = probeOf(["5230.TWO"])
    expect((await resolveSymbolForRead("5230.TW", p.fn)).symbol).toBe("5230.TWO")
  })

  it("falls back to the RAW input when the source is unreachable — a chart must still render", async () => {
    // Not the best guess: the raw form is what fetchOHLCV handles best (it has
    // its own .TW→.TWO fallback), whereas persisting a wrong guess would create
    // exactly the alias this function exists to prevent.
    const p = probeOf([], ["2330.TW", "2330.TWO"])
    expect((await resolveSymbolForRead("2330", p.fn)).symbol).toBe("2330")
  })

  it("leaves US tickers and crypto pairs untouched, and never probes for them", async () => {
    const p = probeOf([])
    expect(await resolveSymbolForRead("aapl", p.fn)).toEqual({ symbol: "AAPL", assetType: "stock" })
    expect(await resolveSymbolForRead("BTCUSDT", p.fn)).toEqual({ symbol: "BTCUSDT", assetType: "crypto" })
    expect(p.calls).toEqual([])
  })
})

describe("resolveTwSuffix — probe the suffix the caller already typed first", () => {
  it("a .TWO input costs ONE probe, not a wasted .TW round trip first", async () => {
    const p = probeOf(["5230.TWO"])
    expect(await resolveTwSuffix("5230", p.fn, "TWO")).toEqual({ symbol: "5230.TWO", resolved: true })
    expect(p.calls).toEqual(["5230.TWO"])
  })

  it("still finds the other exchange when the typed suffix is wrong", async () => {
    const p = probeOf(["5230.TWO"])
    expect(await resolveTwSuffix("5230", p.fn, "TW")).toEqual({ symbol: "5230.TWO", resolved: true })
    expect(p.calls).toEqual(["5230.TW", "5230.TWO"])
  })

  it("an inconclusive FIRST probe still refuses to name the other exchange", async () => {
    const p = probeOf(["5230.TW"], ["5230.TWO"])
    expect((await resolveTwSuffix("5230", p.fn, "TWO")).resolved).toBe(false)
    expect(p.calls).toEqual(["5230.TWO"])
  })

  it("resolveSymbol takes the preference from the input's own suffix", async () => {
    clearSymbolMemo()
    const p = probeOf(["3176.TWO"])
    expect((await resolveSymbol("3176.TWO", p.fn)).symbol).toBe("3176.TWO")
    expect(p.calls).toEqual(["3176.TWO"])   // no wasted .TW probe
  })
})

describe("getAdapter routing", () => {
  // The router used a PREFIX test, so any ticker starting with a coin name went
  // to Kraken and could never resolve. All three are real listed equities.
  it("does not swallow equities whose ticker starts with a coin name", () => {
    for (const t of ["SOLV", "BTCS", "ADAP", "DOTM", "LINKQ", "XRPX"]) {
      expect(`${t}:${getAdapter(t).adapter.getAssetType()}`).toBe(`${t}:stock`)
    }
  })

  it("still routes genuine pairs to the crypto adapter", () => {
    for (const t of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "btcusd"]) {
      expect(`${t}:${getAdapter(t).adapter.getAssetType()}`).toBe(`${t}:crypto`)
    }
  })

  it("reports the feed name, for the cache source column", () => {
    expect(getAdapter("2330.TW").adapter.getSource()).toBe("yahoo")
    expect(getAdapter("BTCUSDT").adapter.getSource()).toBe("kraken")
  })
})
