/**
 * Chart routes — public, no auth required.
 *
 * GET /api/chart/:symbol?days=90
 *   Returns OHLCV + MA25 + MA60 + signal for the given symbol.
 *   Tries cache first; falls back to the appropriate adapter.
 *
 * GET /api/signal/:symbol
 *   Returns only the current signal (lighter response for watchlist list view).
 */

import { Hono } from "hono"
import { getAdapter } from "../adapters/index.js"
import { getCachedOHLCV, upsertOHLCV } from "../cache.js"
import { computeMA, analyzeSymbol } from "../engine/index.js"
import type { ChartData } from "../engine/types.js"

export const chartRouter = new Hono()

chartRouter.get("/chart/:symbol", async c => {
  const symbol = c.req.param("symbol").toUpperCase()
  const days   = Math.min(parseInt(c.req.query("days") ?? "90", 10), 365)

  try {
    const { adapter, normalizedSymbol } = getAdapter(symbol)
    const assetType = adapter.getAssetType()

    // Try cache first
    let ohlcv = await getCachedOHLCV(normalizedSymbol, assetType, days)

    if (!ohlcv) {
      ohlcv = await adapter.fetchOHLCV(normalizedSymbol, days)
      await upsertOHLCV(normalizedSymbol, assetType, ohlcv).catch(() => {})  // non-blocking
    }

    const closes = ohlcv.map(b => b.close)
    const ma25   = computeMA(closes, 25)
    const ma60   = computeMA(closes, 60)
    const result = analyzeSymbol(ohlcv)

    const data: ChartData = {
      symbol:      normalizedSymbol,
      asset_type:  assetType,
      ohlcv,
      ma25,
      ma60,
      signal:      result.signal,
      confidence:  result.confidence,
      signal_date: result.crossIndex !== null ? ohlcv[result.crossIndex]?.date ?? null : null,
    }

    return c.json(data)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[chart] ${symbol}:`, message)
    return c.json({ error: message }, 500)
  }
})

chartRouter.get("/signal/:symbol", async c => {
  const symbol = c.req.param("symbol").toUpperCase()
  const { adapter, normalizedSymbol } = getAdapter(symbol)
  const assetType = adapter.getAssetType()

  let ohlcv = await getCachedOHLCV(normalizedSymbol, assetType, 90)
  if (!ohlcv) {
    ohlcv = await adapter.fetchOHLCV(normalizedSymbol, 90)
    await upsertOHLCV(normalizedSymbol, assetType, ohlcv).catch(() => {})
  }

  const result = analyzeSymbol(ohlcv)
  return c.json({
    symbol:      normalizedSymbol,
    signal:      result.signal,
    confidence:  result.confidence,
    signal_date: result.crossIndex !== null ? ohlcv[result.crossIndex]?.date ?? null : null,
    ma25:        result.ma25,
    ma60:        result.ma60,
  })
})
