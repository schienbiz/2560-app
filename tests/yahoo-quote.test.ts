/**
 * fetchQuote parsing + endpoint regression tests.
 *
 * Two production bugs anchored here:
 *   1. Yahoo v7/finance/quote is crumb-gated (401 Unauthorized for keyless
 *      callers) — the old _yahooQuote silently returned null on EVERY call, so
 *      US stocks never had a live price and the TWSE fallback was dead. The
 *      quote must come from the v8 chart endpoint's meta block instead.
 *   2. TWSE `z` (last trade) is "-" between trades / pre-open / illiquid
 *      symbols; degrading straight to Yahoo swapped a real-time source for a
 *      delayed one. parseTwseSnapshot falls back z → pz → best bid in-snapshot.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { parseTwseSnapshot, parseV8MetaPrice, YahooFinanceAdapter } from "../src/adapters/yahoo.js"
import type { YahooResponse } from "../src/adapters/yahoo.js"

describe("parseTwseSnapshot", () => {
  it("uses z (last trade) when present", () => {
    expect(parseTwseSnapshot({ z: "2370.0000", pz: "2368.0000", b: "2365.0000_2360.0000_" })).toBe(2370)
  })

  it("falls back to pz when z is '-'", () => {
    expect(parseTwseSnapshot({ z: "-", pz: "2368.0000", b: "2365.0000_" })).toBe(2368)
  })

  it("falls back to best bid head when z and pz are '-'", () => {
    expect(parseTwseSnapshot({ z: "-", pz: "-", b: "2365.0000_2360.0000_2355.0000_" })).toBe(2365)
  })

  it("returns null when all fields are unusable", () => {
    expect(parseTwseSnapshot({ z: "-", pz: "-", b: "-" })).toBeNull()
    expect(parseTwseSnapshot({ z: "N/A" })).toBeNull()
    expect(parseTwseSnapshot({})).toBeNull()
    expect(parseTwseSnapshot(undefined)).toBeNull()
  })

  it("rejects zero/negative/garbage prices", () => {
    expect(parseTwseSnapshot({ z: "0" })).toBeNull()
    expect(parseTwseSnapshot({ z: "-5" })).toBeNull()
    expect(parseTwseSnapshot({ z: "abc" })).toBeNull()
  })
})

describe("parseV8MetaPrice", () => {
  const withMeta = (meta: object | undefined): YahooResponse =>
    ({ chart: { result: [{ meta, timestamp: [], indicators: { quote: [] } }] } }) as unknown as YahooResponse

  it("extracts regularMarketPrice from the meta block", () => {
    expect(parseV8MetaPrice(withMeta({ regularMarketPrice: 333.26 }))).toBe(333.26)
  })

  it("returns null when meta or price is missing", () => {
    expect(parseV8MetaPrice(withMeta(undefined))).toBeNull()
    expect(parseV8MetaPrice(withMeta({}))).toBeNull()
    expect(parseV8MetaPrice({ chart: {} } as YahooResponse)).toBeNull()
  })

  it("rejects non-numeric or non-positive prices", () => {
    expect(parseV8MetaPrice(withMeta({ regularMarketPrice: "333" }))).toBeNull()
    expect(parseV8MetaPrice(withMeta({ regularMarketPrice: 0 }))).toBeNull()
  })
})

describe("fetchQuote endpoint routing (v7-crumb regression)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("US symbols hit the v8 chart endpoint, never crumb-gated v7", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({
        chart: { result: [{ meta: { regularMarketPrice: 333.26 }, timestamp: [], indicators: { quote: [] } }] },
      }))
    }))

    const price = await new YahooFinanceAdapter().fetchQuote("AAPL")
    expect(price).toBe(333.26)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("/v8/finance/chart/AAPL")
    expect(calls[0]).not.toContain("/v7/")
  })

  it("TW symbols try TWSE first, then fall back to v8 chart meta", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes("mis.twse.com.tw")) {
        return new Response(JSON.stringify({ msgArray: [] }))   // TWSE down/empty
      }
      return new Response(JSON.stringify({
        chart: { result: [{ meta: { regularMarketPrice: 2375 }, timestamp: [], indicators: { quote: [] } }] },
      }))
    }))

    const price = await new YahooFinanceAdapter().fetchQuote("2330.TW")
    expect(price).toBe(2375)
    expect(calls.some(u => u.includes("mis.twse.com.tw"))).toBe(true)
    expect(calls[calls.length - 1]).toContain("/v8/finance/chart/2330.TW")
  })

  it("TW symbols return the TWSE tick without touching Yahoo when available", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ msgArray: [{ z: "2370.0000" }] }))
    }))

    const price = await new YahooFinanceAdapter().fetchQuote("2330.TW")
    expect(price).toBe(2370)
    expect(calls.every(u => u.includes("mis.twse.com.tw"))).toBe(true)
  })

  it(".TW routes straight to TSE — no wasted OTC probe", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ msgArray: [{ z: "2370.0000" }] }))
    }))

    await new YahooFinanceAdapter().fetchQuote("2330.TW")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("ex_ch=tse_2330.tw")
  })

  it(".TWO routes straight to OTC", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ msgArray: [{ z: "88.5" }] }))
    }))

    const price = await new YahooFinanceAdapter().fetchQuote("8937.TWO")
    expect(price).toBe(88.5)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("ex_ch=otc_8937.two")
  })

  it("bare 4-digit shorthand probes both exchanges in parallel and picks the hit", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes("ex_ch=otc_")) {
        return new Response(JSON.stringify({ msgArray: [{ z: "88.5" }] }))
      }
      return new Response(JSON.stringify({ msgArray: [] }))   // not TSE-listed
    }))

    const price = await new YahooFinanceAdapter().fetchQuote("8937")
    expect(price).toBe(88.5)
    expect(calls.filter(u => u.includes("mis.twse.com.tw"))).toHaveLength(2)
  })
})
