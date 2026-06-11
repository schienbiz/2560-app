/**
 * AI analysis route — requires auth.
 *
 * POST /api/ai/analyze/:symbol
 *   Body (optional): { "question": "現在可以進場嗎？" }
 *   Returns: { "analysis": "..." }
 */

import { Hono } from "hono"
import { authMiddleware } from "../auth.js"
import { analyzeChart } from "../services/ai.js"
import { getAdapter } from "../adapters/index.js"
import { computeMA } from "../engine/index.js"
import { scoreSignal } from "../engine/signal.js"
import { computeSR } from "../engine/sr.js"
import { getOrFetchOHLCV, fetchDaysFor } from "../utils/ohlcv.js"
import { db } from "../db.js"
import type { ChartData } from "../engine/types.js"

export const aiRouter = new Hono()
aiRouter.use("*", authMiddleware)

aiRouter.post("/analyze/:symbol", async c => {
  const hasKey = process.env.NVIDIA_API_KEY || process.env.GROQ_API_KEY ||
                 process.env.CEREBRAS_API_KEY || process.env.OPENROUTER_API_KEY
  if (!hasKey) return c.json({ error: "AI 功能尚未啟用" }, 503)

  const symbol = c.req.param("symbol").toUpperCase()
  const body   = await c.req.json<{ question?: string }>().catch(() => ({ question: undefined }))

  try {
    const { userId, platform } = c.get("user")
    const { adapter, normalizedSymbol } = getAdapter(symbol)
    const assetType = adapter.getAssetType()

    // Use the user's configured MA periods for this symbol (if any)
    const watchlistItem = await db.watchlist.findFirst({
      where: { user_id: userId, platform, symbol: normalizedSymbol },
      include: { alert: true },
    })
    const fastPeriod = watchlistItem?.alert?.fast_period ?? 25
    const slowPeriod = watchlistItem?.alert?.slow_period ?? 60
    const days = Math.max(120, fetchDaysFor(slowPeriod, assetType))

    const ohlcv = await getOrFetchOHLCV(normalizedSymbol, assetType, days, adapter)
    if (ohlcv.length === 0) return c.json({ error: `找不到標的：${normalizedSymbol}` }, 404)

    const closes = ohlcv.map(b => b.close)
    const ma25   = computeMA(closes, fastPeriod)
    const ma60   = computeMA(closes, slowPeriod)
    const result = scoreSignal(ohlcv, ma25, ma60)
    const sr     = computeSR(ohlcv)

    const data: ChartData = {
      symbol:      normalizedSymbol,
      asset_type:  assetType,
      ohlcv,
      ma25,
      ma60,
      signal:      result.signal,
      confidence:  result.confidence,
      signal_date: result.crossIndex !== null ? ohlcv[result.crossIndex]?.date ?? null : null,
      support:     sr.support,
      resistance:  sr.resistance,
      rsi:         result.rsi,
      macdHist:    result.macdHist,
    }

    const analysis = await analyzeChart(data, body.question)
    return c.json({ analysis })
  } catch (err) {
    console.error("[ai/analyze]", err)
    return c.json({ error: "分析失敗，請稍後再試" }, 500)
  }
})
