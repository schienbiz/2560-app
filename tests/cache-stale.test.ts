import { describe, it, expect } from "vitest"
import { isCacheStale, isBarTooOld, DIGEST_MAX_BAR_AGE_DAYS } from "../src/cache.js"

const NOW = Date.parse("2026-07-05T12:00:00Z")
const minsAgo = (m: number) => new Date(NOW - m * 60_000)
const d = (s: string) => new Date(`${s}T00:00:00Z`)

describe("isCacheStale", () => {
  describe("crypto — flat 15-minute TTL", () => {
    it("fresh under 15 min", () => {
      expect(isCacheStale(d("2026-07-04"), minsAgo(10), "crypto", NOW)).toBe(false)
    })
    it("stale over 15 min", () => {
      expect(isCacheStale(d("2026-07-04"), minsAgo(20), "crypto", NOW)).toBe(true)
    })
  })

  describe("stock — today's forming bar gets a 30-minute TTL", () => {
    it("today's bar fetched 20 min ago is fresh", () => {
      expect(isCacheStale(d("2026-07-05"), minsAgo(20), "stock", NOW)).toBe(false)
    })
    it("today's bar fetched 40 min ago is stale (would have frozen for hours before the fix)", () => {
      expect(isCacheStale(d("2026-07-05"), minsAgo(40), "stock", NOW)).toBe(true)
    })
  })

  describe("stock — settled past day keeps the overnight buffer", () => {
    it("fetched this morning is still fresh (next 05:30 UTC not reached)", () => {
      // fetchedAt 2026-07-05 06:00Z → fresh until 2026-07-06 05:30Z; NOW is 07-05 12:00Z
      expect(isCacheStale(d("2026-07-03"), new Date("2026-07-05T06:00:00Z"), "stock", NOW)).toBe(false)
    })
    it("fetched yesterday is stale (past next 05:30 UTC)", () => {
      // fetchedAt 2026-07-04 06:00Z → stale after 2026-07-05 05:30Z; NOW is 07-05 12:00Z
      expect(isCacheStale(d("2026-07-03"), new Date("2026-07-04T06:00:00Z"), "stock", NOW)).toBe(true)
    })
  })

  describe("stock — the 06:00 UTC scan must never be served the previous day's series", () => {
    // Regression: with the old 08:00 UTC horizon, a series fetched by
    // yesterday's 06:00 scan was still "fresh" at today's 06:00 scan, so the
    // scan scored yesterday's bars — and since detectCross only fires on the
    // last bar transition, a cross landing on today's bar was permanently
    // dropped once tomorrow's refetch moved past it.
    it("fetched by yesterday's scan (06:05) → stale at today's 06:00 scan", () => {
      const scanTime = Date.parse("2026-07-06T06:00:00Z")
      expect(isCacheStale(d("2026-07-05"), new Date("2026-07-05T06:05:00Z"), "stock", scanTime)).toBe(true)
    })
    it("fetched during the overnight window (00:30) → stale at the SAME day's 06:00 scan", () => {
      // "Next 05:30", not "next day 05:30": a cold-start fetch at 00:30 holds
      // yesterday's closes and must expire before the same morning's scan.
      const scanTime = Date.parse("2026-07-06T06:00:00Z")
      expect(isCacheStale(d("2026-07-05"), new Date("2026-07-06T00:30:00Z"), "stock", scanTime)).toBe(true)
    })
    it("overnight consumers (00:00–05:30) still ride the buffer", () => {
      const remindTime = Date.parse("2026-07-06T00:30:00Z")
      expect(isCacheStale(d("2026-07-05"), new Date("2026-07-05T06:05:00Z"), "stock", remindTime)).toBe(false)
    })
  })
})

// ─── Digest freshness: bar age, not fetch age ────────────────────────────────
//
// Regression for a silent omission found in production on 2026-09-07. The
// morning summary reads the cache and deliberately never fetches, so it was
// gated on isCacheStale — whose crypto rule is a flat 15-minute FETCH TTL. That
// cron runs at 00:00 UTC while the crypto scan writes at 01:00 UTC, so the
// newest crypto write was always ~23 h old and therefore always "stale": every
// crypto symbol was dropped and the user was told 「今天自選股全部平靜」 on a
// day BTCUSDT had crossed.

describe("isBarTooOld — the rule a report should use", () => {
  it("yesterday's settled crypto bar is reportable, though isCacheStale calls the row stale", () => {
    const bar = d("2026-07-04")
    const fetchedYesterday = new Date(NOW - 23 * 60 * 60_000)
    expect(isCacheStale(bar, fetchedYesterday, "crypto", NOW)).toBe(true)   // correct for a scan
    expect(isBarTooOld(bar, DIGEST_MAX_BAR_AGE_DAYS, NOW)).toBe(false)      // correct for a digest
  })

  it("a Friday close read on the following Monday is still reportable", () => {
    const monday = Date.parse("2026-07-06T00:30:00Z")
    expect(isBarTooOld(d("2026-07-03"), DIGEST_MAX_BAR_AGE_DAYS, monday)).toBe(false)
  })

  it("an abandoned series is NOT narrated as today's news", () => {
    expect(isBarTooOld(d("2026-06-01"), DIGEST_MAX_BAR_AGE_DAYS, NOW)).toBe(true)
  })

  it("boundary: exactly maxAgeDays old is still acceptable", () => {
    const bar = new Date(NOW - DIGEST_MAX_BAR_AGE_DAYS * 24 * 60 * 60_000)
    expect(isBarTooOld(bar, DIGEST_MAX_BAR_AGE_DAYS, NOW)).toBe(false)
  })
})
