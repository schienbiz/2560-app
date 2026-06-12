/**
 * Backtest route — simulate 2560戰法 on historical data.
 *
 * GET /api/backtest/:symbol?days=365
 *   Returns BacktestResult: all golden→death round trips, 4-factor confidence
 *   per entry, win rate, avg return, profit factor, max drawdown, expectancy,
 *   equity curve, and by-confidence breakdown.  Max days: 1095 (3 years).
 *   No auth required — same as chart data.
 */

import { Hono } from "hono"
import { getAdapter } from "../adapters/index.js"
import { getOrFetchOHLCV } from "../utils/ohlcv.js"
import { runBacktest } from "../engine/backtest.js"

export const backtestRouter = new Hono()

backtestRouter.get("/:symbol", async c => {
  const symbol     = c.req.param("symbol").toUpperCase()
  const days       = Math.min(parseInt(c.req.query("days") ?? "365", 10), 1095)
  const fastPeriod = Math.min(Math.max(parseInt(c.req.query("fast_period") ?? "25", 10), 2), 200)
  const slowPeriod = Math.min(Math.max(parseInt(c.req.query("slow_period") ?? "60", 10), 3), 200)

  try {
    const { adapter, normalizedSymbol } = getAdapter(symbol)
    const assetType = adapter.getAssetType()
    const ohlcv     = await getOrFetchOHLCV(normalizedSymbol, assetType, days, adapter)

    if (ohlcv.length < slowPeriod + 5) {
      return c.json({ error: `資料不足（MA${slowPeriod} 需要至少 ${slowPeriod + 5} 根 K 線）` }, 400)
    }

    return c.json(runBacktest(normalizedSymbol, ohlcv, fastPeriod, slowPeriod))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const is404 = msg.includes("404") || msg.toLowerCase().includes("no data")
    return c.json({ error: msg }, is404 ? 404 : 500)
  }
})
