/**
 * On-demand watchlist scan.
 *
 * GET /api/scan
 *   Fetches current signal status for all symbols in the user's watchlist.
 *   Uses cached OHLCV when available; falls back to live fetch.
 *   Processes symbols concurrently (Promise.allSettled).
 */

import { Hono } from "hono"
import { db } from "../db.js"
import { authMiddleware } from "../auth.js"
import { getAdapter } from "../adapters/index.js"
import { computeMA } from "../engine/index.js"
import { scoreSignal } from "../engine/signal.js"
import { getOrFetchOHLCV, fetchDaysFor } from "../utils/ohlcv.js"

export const scanRouter = new Hono()
scanRouter.use("*", authMiddleware)

scanRouter.get("/", async c => {
  const { userId, platform } = c.get("user")

  const watchlist = await db.watchlist.findMany({
    where: { user_id: userId, platform },
    include: { alert: true },
    orderBy: { created_at: "asc" },
  })

  if (!watchlist.length) return c.json([])

  const results = await Promise.allSettled(
    watchlist.map(async item => {
      const { adapter, normalizedSymbol } = getAdapter(item.symbol)
      const assetType = adapter.getAssetType()
      const fastPeriod = item.alert?.fast_period ?? 25
      const slowPeriod = item.alert?.slow_period ?? 60
      const days = fetchDaysFor(slowPeriod, assetType)

      const ohlcv  = await getOrFetchOHLCV(normalizedSymbol, assetType, days, adapter)
      const closes = ohlcv.map(b => b.close)
      const maFast = computeMA(closes, fastPeriod)
      const maSlow = computeMA(closes, slowPeriod)
      const result = scoreSignal(ohlcv, maFast, maSlow)
      const latest = ohlcv[ohlcv.length - 1]

      return {
        symbol:      item.symbol,
        asset_type:  assetType,
        close:       latest?.close ?? null,
        signal:      result.signal,
        confidence:  result.confidence,
        ma25:        result.ma25,
        ma60:        result.ma60,
        fast_period: fastPeriod,
        slow_period: slowPeriod,
      }
    })
  )

  const output = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { symbol: watchlist[i].symbol, error: (r.reason as Error).message ?? "failed" }
  )

  return c.json(output)
})
