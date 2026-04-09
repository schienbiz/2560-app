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

function isStale(fetchedAt: Date, assetType: AssetType): boolean {
  const now = Date.now()
  if (assetType === "crypto") {
    return now - fetchedAt.getTime() > 15 * 60 * 1000   // 15 min
  }
  // Stock: stale after 8am UTC next day (gives overnight buffer for after-hours data)
  const nextDayClose = new Date(fetchedAt)
  nextDayClose.setUTCDate(nextDayClose.getUTCDate() + 1)
  nextDayClose.setUTCHours(8, 0, 0, 0)
  return now > nextDayClose.getTime()
}

export async function getCachedOHLCV(
  symbol: string,
  assetType: AssetType,
  days: number
): Promise<OHLCV[] | null> {
  const rows = await db.ohlcvCache.findMany({
    where: { symbol },
    orderBy: { date: "asc" },
  })

  if (rows.length === 0) return null

  const latest = rows[rows.length - 1]
  if (isStale(latest.fetched_at, assetType)) return null
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

export async function upsertOHLCV(
  symbol: string,
  source: string,
  bars: OHLCV[]
): Promise<void> {
  // Upsert in batches to avoid oversized queries
  for (const b of bars) {
    await db.ohlcvCache.upsert({
      where: { symbol_date: { symbol, date: new Date(b.date) } },
      create: { symbol, source, date: new Date(b.date), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume },
      update: { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, fetched_at: new Date() },
    })
  }
}
