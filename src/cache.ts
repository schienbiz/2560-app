/**
 * OHLCV cache layer.
 *
 * Cache strategy:
 *   Stock:  TTL until market close today (4pm local → use end-of-day UTC)
 *           Any cached bar for today's date is fresh until 8am UTC next day.
 *   Crypto: TTL = 15 minutes (market never closes)
 */

import { db } from "./db.js"
import type { OHLCV, AssetType } from "./engine/types.js"

/**
 * Is the cached series stale?
 *
 * `latestBarDate` is the date of the newest cached bar; `fetchedAt` is when it
 * was written. Pure (inject `now` for tests).
 *
 * Stock nuance: a bar dated *today* is still forming during market hours. The
 * old rule ("fresh until 08:00 UTC next day") froze an intraday snapshot for up
 * to ~14 hours, so an on-demand chart opened mid-session kept a mid-day price as
 * the last MA point through the real close. Today-dated stock bars now get a
 * 30-minute TTL so interactive reads refresh; settled past days keep the long
 * overnight buffer.
 *
 * The settled-day horizon must expire BEFORE the earliest daily scan (scan-tw
 * at 06:00 UTC, minutes after the 05:30 UTC TWSE close). With the previous
 * 08:00 UTC horizon, a series fetched by yesterday's 06:00 scan was still
 * "fresh" at today's 06:00 scan — the scan scored yesterday's bars, and since
 * detectCross only fires on the last bar transition, a cross landing on
 * today's bar was never detected once tomorrow's refetch moved past it.
 * 05:30 UTC keeps every overnight consumer (morning summary 00:00, remind
 * 00:30) on the buffer while guaranteeing each scan sees that day's close.
 */
export function isCacheStale(
  latestBarDate: Date,
  fetchedAt: Date,
  assetType: AssetType,
  now: number = Date.now()
): boolean {
  if (assetType === "crypto") {
    return now - fetchedAt.getTime() > 15 * 60 * 1000   // 15 min
  }
  const todayUTC = new Date(now).toISOString().slice(0, 10)
  if (latestBarDate.toISOString().slice(0, 10) === todayUTC) {
    return now - fetchedAt.getTime() > 30 * 60 * 1000    // forming bar → short TTL
  }
  // Settled past day: fresh until the NEXT 05:30 UTC after the fetch — just
  // before scan-tw (06:00 UTC), the earliest daily scan. "Next" (not "the day
  // after"): a fetch landing between 00:00 and 05:30 (morning summary/remind
  // cold start) must expire at the SAME day's 05:30, or the 06:00 scan would
  // be served yesterday's series and the day's cross silently dropped.
  const cutoff = new Date(fetchedAt)
  cutoff.setUTCHours(5, 30, 0, 0)
  if (cutoff.getTime() <= fetchedAt.getTime()) cutoff.setUTCDate(cutoff.getUTCDate() + 1)
  return now > cutoff.getTime()
}

export async function getCachedOHLCV(
  symbol: string,
  assetType: AssetType,
  days: number
): Promise<OHLCV[] | null> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const rows = await db.ohlcvCache.findMany({
    where: { symbol, date: { gte: cutoff } },
    orderBy: { date: "asc" },
  })

  if (rows.length === 0) return null

  const latest = rows[rows.length - 1]
  if (isCacheStale(latest.date, latest.fetched_at, assetType)) return null
  if (rows.length < Math.min(days, 60)) return null   // not enough history

  return rows.slice(-days).map(r => ({
    date:   r.date.toISOString().slice(0, 10),
    open:   r.open,
    high:   r.high,
    low:    r.low,
    close:  r.close,
    volume: r.volume,
  }))
}

const UPSERT_BATCH = 20

export async function upsertOHLCV(
  symbol: string,
  source: string,
  bars: OHLCV[]
): Promise<void> {
  // Batch into groups of UPSERT_BATCH to avoid saturating the DB connection pool
  // (90 parallel upserts would open 90 connections; sequential batches are safer)
  for (let i = 0; i < bars.length; i += UPSERT_BATCH) {
    await db.$transaction(
      bars.slice(i, i + UPSERT_BATCH).map(b =>
        db.ohlcvCache.upsert({
          where:  { symbol_date: { symbol, date: new Date(b.date) } },
          create: { symbol, source, date: new Date(b.date), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume },
          update: { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, fetched_at: new Date() },
        })
      )
    )
  }
}
