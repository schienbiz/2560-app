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
import { getCachedOHLCV, upsertOHLCV } from "../cache.js"
import { analyzeSymbol } from "../engine/index.js"

export const scanRouter = new Hono()
scanRouter.use("*", authMiddleware)

scanRouter.get("/", async c => {
  const { userId, platform } = c.get("user")

  const watchlist = await db.watchlist.findMany({
    where: { user_id: userId, platform },
    orderBy: { created_at: "asc" },
  })

  if (!watchlist.length) return c.json([])

  const results = await Promise.allSettled(
    watchlist.map(async item => {
      const { adapter, normalizedSymbol } = getAdapter(item.symbol)
      const assetType = adapter.getAssetType()

      let ohlcv = await getCachedOHLCV(normalizedSymbol, assetType, 90)
      if (!ohlcv) {
        ohlcv = await adapter.fetchOHLCV(normalizedSymbol, 90)
        await upsertOHLCV(normalizedSymbol, assetType, ohlcv).catch(() => {})
      }

      const result = analyzeSymbol(ohlcv)
      const latest = ohlcv[ohlcv.length - 1]

      return {
        symbol:     item.symbol,
        asset_type: assetType,
        close:      latest?.close ?? null,
        signal:     result.signal,
        confidence: result.confidence,
        ma25:       result.ma25,
        ma60:       result.ma60,
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
