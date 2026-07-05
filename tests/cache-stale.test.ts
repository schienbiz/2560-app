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
    it("fetched this morning is still fresh (next 08:00 UTC not reached)", () => {
      // fetchedAt 2026-07-05 06:00Z → fresh until 2026-07-06 08:00Z; NOW is 07-05 12:00Z
      expect(isCacheStale(d("2026-07-03"), new Date("2026-07-05T06:00:00Z"), "stock", NOW)).toBe(false)
    })
    it("fetched yesterday is stale (past next 08:00 UTC)", () => {
      // fetchedAt 2026-07-04 06:00Z → stale after 2026-07-05 08:00Z; NOW is 07-05 12:00Z
      expect(isCacheStale(d("2026-07-03"), new Date("2026-07-04T06:00:00Z"), "stock", NOW)).toBe(true)
    })
  })
})
