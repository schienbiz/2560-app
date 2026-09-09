/**
 * Cache WRITE semantics — which path may store today's bar, and which must not.
 *
 * Production incident, 2026-09-08. The benchmark-index refresh added in v1.7.0
 * runs from the daily outcome cron, nominally 10:00 UTC; GitHub actually started
 * it at 14:12 UTC (its previous starts were 13:26 and 15:33 — routinely after
 * the 13:30 US open). Yahoo returned SPY's still-forming session candle, and
 * because bulkInsertOHLCV uses createMany({skipDuplicates:true}) that mid-session
 * price became the permanent 2026-09-08 close:
 *
 *   cached close 766.395   (fetched 14:12:53 UTC, mid-session)
 *   real close   765.960
 *
 * A later fetch of the settled value is SKIPPED, not applied, so nothing could
 * ever repair it. 0050.TW was worse — fetched at 04:47 UTC with the Taiwan
 * session still open, it stored a provisional bar the source no longer reports.
 * Kraken never had the problem: normalizeKrakenBars already drops the
 * uncommitted candle using `result.last`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const createMany = vi.fn()
const upsert = vi.fn()
const transaction = vi.fn()

vi.mock("../src/db.js", () => ({
  db: {
    ohlcvCache: {
      createMany: (...a: unknown[]) => createMany(...a),
      upsert:     (...a: unknown[]) => upsert(...a),
    },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}))

import { settledBarsOnly, bulkInsertOHLCV, upsertOHLCV } from "../src/cache.js"
import type { OHLCV } from "../src/engine/types.js"

const bar = (date: string, close: number): OHLCV =>
  ({ date, open: close, high: close, low: close, close, volume: 1 })

const NOW = Date.parse("2026-09-08T14:12:53Z")   // the moment of the incident

describe("settledBarsOnly", () => {
  it("drops the bar dated today — it is the still-forming session candle", () => {
    const kept = settledBarsOnly(
      [bar("2026-09-04", 770.19), bar("2026-09-08", 766.395)], NOW)
    expect(kept.map(b => b.date)).toEqual(["2026-09-04"])
  })

  it("keeps every settled day", () => {
    const kept = settledBarsOnly(
      [bar("2026-09-02", 1), bar("2026-09-03", 2), bar("2026-09-04", 3)], NOW)
    expect(kept).toHaveLength(3)
  })

  it("drops future-dated bars too — `< today`, not `!== today`", () => {
    const kept = settledBarsOnly([bar("2026-09-04", 1), bar("2026-09-30", 2)], NOW)
    expect(kept.map(b => b.date)).toEqual(["2026-09-04"])
  })

  it("the cut is the UTC day boundary, and that cost is deliberate", () => {
    // At 23:59 UTC on the 8th the US session has been closed for four hours, so
    // that bar IS settled — and it is still dropped, because there is no
    // per-market close time here and a wrong price is worse than a late one.
    // One second later it is yesterday's bar and goes in.
    const justBefore = Date.parse("2026-09-08T23:59:59Z")
    const justAfter  = Date.parse("2026-09-09T00:00:00Z")
    expect(settledBarsOnly([bar("2026-09-08", 1)], justBefore)).toHaveLength(0)
    expect(settledBarsOnly([bar("2026-09-08", 1)], justAfter)).toHaveLength(1)
  })

  it("an all-today batch becomes empty rather than throwing", () => {
    expect(settledBarsOnly([bar("2026-09-08", 1)], NOW)).toEqual([])
  })
})

describe("bulkInsertOHLCV", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    createMany.mockResolvedValue({ count: 0 })
  })

  it("writes only settled bars, and keeps skipDuplicates", async () => {
    await bulkInsertOHLCV("SPY", "yahoo", [bar("2026-09-04", 770.19), bar("2026-09-08", 766.395)])

    expect(createMany).toHaveBeenCalledTimes(1)
    const arg = createMany.mock.calls[0][0] as { data: Array<{ date: Date }>; skipDuplicates: boolean }
    expect(arg.skipDuplicates).toBe(true)
    expect(arg.data).toHaveLength(1)
    expect(arg.data[0].date.toISOString().slice(0, 10)).toBe("2026-09-04")
  })

  it("issues NO query at all when every bar is today's", async () => {
    await bulkInsertOHLCV("SPY", "yahoo", [bar("2026-09-08", 766.395)])
    expect(createMany).not.toHaveBeenCalled()
  })

  it("issues no query for an empty batch", async () => {
    await bulkInsertOHLCV("SPY", "yahoo", [])
    expect(createMany).not.toHaveBeenCalled()
  })
})

describe("upsertOHLCV must NOT drop today's bar", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    transaction.mockResolvedValue(undefined)
    upsert.mockImplementation((a: unknown) => a)
  })

  /**
   * The opposite requirement, and the reason the guard lives in
   * bulkInsertOHLCV rather than in a shared helper: the scan reads the cache
   * and fires on the LAST bar's transition, so today's settled bar has to be
   * there. This path updates on conflict, so an intraday write is corrected by
   * the next read — isCacheStale gives a today-dated stock bar a 30-minute TTL
   * precisely so that happens. Applying the settled-only rule here would stop
   * the scanner ever seeing the day it is supposed to act on.
   */
  it("passes today's bar through to the upsert", async () => {
    await upsertOHLCV("2330.TW", "yahoo", [bar("2026-09-04", 100), bar("2026-09-08", 110)])

    expect(transaction).toHaveBeenCalledTimes(1)
    const ops = transaction.mock.calls[0][0] as Array<{ create: { date: Date } }>
    expect(ops).toHaveLength(2)
    expect(ops.map(o => o.create.date.toISOString().slice(0, 10)))
      .toEqual(["2026-09-04", "2026-09-08"])
  })

  it("updates on conflict, which is what lets an intraday write self-heal", async () => {
    await upsertOHLCV("2330.TW", "yahoo", [bar("2026-09-08", 110)])
    const ops = transaction.mock.calls[0][0] as Array<{ update: Record<string, unknown> }>
    expect(ops[0].update).toMatchObject({ close: 110 })
    expect(ops[0].update).toHaveProperty("fetched_at")
  })
})
