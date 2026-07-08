import { describe, it, expect } from "vitest"
import { isCacheStale } from "../src/cache.js"

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
