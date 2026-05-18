/**
 * Backtest route — simulate 2560戰法 on historical data.
 *
 * GET /api/backtest/:symbol?days=365
 *   Returns BacktestResult: all golden→death round trips, 4-factor confidence
 *   per entry, win rate, avg return, best/worst trade.
 *   No auth required — same as chart data.
 */

import { Hono } from "hono"
import { getAdapter } from "../adapters/index.js"
import { getOrFetchOHLCV } from "../utils/ohlcv.js"
import { runBacktest } from "../engine/backtest.js"

export const backtestRouter = new Hono()

backtestRouter.get("/:symbol", async c => {
  const symbol = c.req.param("symbol").toUpperCase()
  const days   = Math.min(parseInt(c.req.query("days") ?? "365", 10), 730)

  try {
    const { adapter, normalizedSymbol } = getAdapter(symbol)
    const assetType = adapter.getAssetType()
    const ohlcv     = await getOrFetchOHLCV(normalizedSymbol, assetType, days, adapter)

    if (ohlcv.length < 65) {
      return c.json({ error: "資料不足（至少需要 65 根 K 線）" }, 400)
    }

    return c.json(runBacktest(normalizedSymbol, ohlcv))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const is404 = msg.includes("404") || msg.toLowerCase().includes("no data")
    return c.json({ error: msg }, is404 ? 404 : 500)
  }
})
