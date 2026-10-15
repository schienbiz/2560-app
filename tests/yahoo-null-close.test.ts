/**
 * Yahoo's post-midnight null close, and the meta fill that recovers it.
 *
 * Every fixture value is the one measured on 2026-10-14→15 (probe of DIS/SMCI/SPY):
 * the 10-14 session's bar had close = null from ~00:08 to ~00:28 UTC while meta held
 * regularMarketPrice 108.99 @ 20:03Z, day high/low 109.03 / 107.65, gmtoffset -14400,
 * and currentTradingPeriod already pointing at the 10-15 session.
 *
 * The fill writes permanent cache rows (settled days are insert-once), so the cases
 * that must NOT fill matter as much as the one that must.
 */
import { describe, it, expect } from "vitest"
import { normalizeYahooBars, settledLastBarFromMeta, type YahooChartMeta } from "../src/adapters/yahoo.js"

const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)

// Two sessions: 10-13 settled with a close, 10-14 the one Yahoo nulled.
const TS = [at("2026-10-13T13:30:00Z"), at("2026-10-14T13:30:00Z")]
const quoteWithNullLast = (open: number | null = 108.5) => ({
  open:   [109.52, open],
  high:   [110.16, null],
  low:    [107.95, null],
  close:  [108.58, null],
  volume: [10568100, null],
})
const NIGHT_META: YahooChartMeta = {
  regularMarketPrice:   108.99,
  regularMarketTime:    at("2026-10-14T20:03:00Z"),
  regularMarketDayHigh: 109.03,
  regularMarketDayLow:  107.65,
  regularMarketVolume:  8276454,
  gmtoffset:            -14400,
  currentTradingPeriod: { regular: { start: at("2026-10-15T13:30:00Z"), end: at("2026-10-15T20:00:00Z") } },
}

describe("Yahoo null close after midnight — meta fill", () => {
  it("recovers the settled session's bar exactly as Yahoo publishes it ~30 min later", () => {
    const bars = normalizeYahooBars(TS, quoteWithNullLast(), 10, NIGHT_META)
    expect(bars.map(b => b.date)).toEqual(["2026-10-13", "2026-10-14"])
    expect(bars[1]).toEqual({ date: "2026-10-14", open: 108.5, high: 109.03, low: 107.65, close: 108.99, volume: 8276454 })
  })

  it("without meta the bar is dropped, exactly as before (backward compatible)", () => {
    const bars = normalizeYahooBars(TS, quoteWithNullLast(), 10)
    expect(bars.map(b => b.date)).toEqual(["2026-10-13"])
  })

  it("never fills today's pre-open placeholder with yesterday's close", () => {
    // Before the open Yahoo can append today's bar with every field null, while
    // meta still holds YESTERDAY's close. Filling it would write a fake bar for a
    // session that has not traded — permanently.
    const ts = [at("2026-10-14T13:30:00Z"), at("2026-10-15T13:30:00Z")]
    const quote = { open: [108.5, null], high: [109.03, null], low: [107.65, null], close: [108.99, null], volume: [8276400, null] }
    const bars = normalizeYahooBars(ts, quote, 10, NIGHT_META)
    expect(bars.map(b => b.date)).toEqual(["2026-10-14"])
  })

  it("declines while Yahoo still calls this session current (not provably settled)", () => {
    const meta = { ...NIGHT_META, currentTradingPeriod: { regular: { start: TS[1], end: at("2026-10-14T20:00:00Z") } } }
    expect(settledLastBarFromMeta(TS[1], 108.5, meta)).toBeNull()
  })

  it("declines a price from a LATER session (only the date check stands between it and a wrong bar)", () => {
    // 10-14 is still null but meta has already moved on to 10-15's close: every other
    // guard passes (Yahoo rolled past 10-14, the price is after 10-14's open), so the
    // exchange-date match is the one thing keeping 10-15's price out of 10-14's bar.
    const meta = { ...NIGHT_META, regularMarketPrice: 111.11, regularMarketTime: at("2026-10-15T20:00:00Z"),
      currentTradingPeriod: { regular: { start: at("2026-10-16T13:30:00Z") } } }
    expect(settledLastBarFromMeta(TS[1], 108.5, meta)).toBeNull()
  })

  it("compares dates in EXCHANGE time, not UTC", () => {
    // 23:00 New York on 10-14 is 03:00 UTC on 10-15: a UTC comparison would call
    // this a different session and refuse a correct fill.
    const meta = { ...NIGHT_META, regularMarketTime: at("2026-10-15T03:00:00Z") }
    expect(settledLastBarFromMeta(TS[1], 108.5, meta)?.close).toBe(108.99)
  })

  it("works for Taipei too (positive offset, morning-UTC session)", () => {
    const meta: YahooChartMeta = {
      regularMarketPrice: 2490, regularMarketTime: at("2026-10-14T05:30:00Z"),
      regularMarketDayHigh: 2535, regularMarketDayLow: 2490, regularMarketVolume: 23305802,
      gmtoffset: 28800, currentTradingPeriod: { regular: { start: at("2026-10-15T01:00:00Z") } },
    }
    expect(settledLastBarFromMeta(at("2026-10-14T01:00:00Z"), 2505, meta))
      .toEqual({ date: "2026-10-14", open: 2505, high: 2535, low: 2490, close: 2490, volume: 23305802 })
  })

  it("a close-less bar in the MIDDLE of the series stays dropped (halt/gap), meta or not", () => {
    const ts = [...TS, at("2026-10-15T13:30:00Z")]
    const quote = {
      open: [109.52, null, 109], high: [110.16, null, 110], low: [107.95, null, 108],
      close: [108.58, null, 109.5], volume: [1, null, 1],
    }
    const bars = normalizeYahooBars(ts, quote, 10, NIGHT_META)
    expect(bars.map(b => b.date)).toEqual(["2026-10-13", "2026-10-15"])
  })

  it("falls back to the close for open/high/low when meta cannot supply them sanely", () => {
    const meta = { ...NIGHT_META, regularMarketDayHigh: 100, regularMarketDayLow: 90 }   // does not bracket 108.99
    expect(settledLastBarFromMeta(TS[1], null, meta))
      .toEqual({ date: "2026-10-14", open: 108.99, high: 108.99, low: 108.99, close: 108.99, volume: 8276454 })
  })

  it.each([
    ["no price",       { regularMarketPrice: undefined }],
    ["zero price",     { regularMarketPrice: 0 }],
    ["no price time",  { regularMarketTime: undefined }],
    ["no gmtoffset",   { gmtoffset: undefined }],
    ["no next period", { currentTradingPeriod: undefined }],
    ["price from before this session opened", { regularMarketTime: at("2026-10-14T13:00:00Z") }],
  ])("declines with %s", (_label, patch) => {
    expect(settledLastBarFromMeta(TS[1], 108.5, { ...NIGHT_META, ...patch } as YahooChartMeta)).toBeNull()
  })
})
