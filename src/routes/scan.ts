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
import { scoreSignal, hasSufficientBars } from "../engine/signal.js"
import { getOrFetchOHLCV, fetchDaysFor } from "../utils/ohlcv.js"
import { fetchQuoteSafe } from "../utils/quote.js"

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

      // Quote and bars are independent — fetch in parallel so a scan press
      // costs one round trip, not two.
      const [ohlcv, quote] = await Promise.all([
        getOrFetchOHLCV(normalizedSymbol, assetType, days, adapter),
        fetchQuoteSafe(adapter, normalizedSymbol),
      ])
      const closes = ohlcv.map(b => b.close)
      const maFast = computeMA(closes, fastPeriod)
      const maSlow = computeMA(closes, slowPeriod)
      const result = scoreSignal(ohlcv, maFast, maSlow)
      const enough = hasSufficientBars(ohlcv.length, slowPeriod)
      const latest = ohlcv[ohlcv.length - 1]

      return {
        symbol:      item.symbol,
        asset_type:  assetType,
        // Live quote, not the cached bar close: during TW market hours the
        // settled-day cache still ends at yesterday's bar (kept fresh until
        // 05:30 UTC for scan-tw), so the bar close is the PREVIOUS session's
        // close — visibly wrong next to a brokerage app's real-time price.
        close:       quote ?? latest?.close ?? null,
        signal:      enough ? result.signal : "none",
        confidence:  enough ? result.confidence : "low",
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
