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
import { getCachedOHLCV, upsertOHLCV } from "../cache.js"
import { computeMA, analyzeSymbol } from "../engine/index.js"
import { computeSR } from "../engine/sr.js"
import type { ChartData } from "../engine/types.js"

export const aiRouter = new Hono()
aiRouter.use("*", authMiddleware)

aiRouter.post("/analyze/:symbol", async c => {
  if (!process.env.GROQ_API_KEY) {
    return c.json({ error: "AI 功能尚未啟用" }, 503)
  }

  const symbol = c.req.param("symbol").toUpperCase()
  const body   = await c.req.json<{ question?: string }>().catch(() => ({ question: undefined }))

  try {
    const { adapter, normalizedSymbol } = getAdapter(symbol)
    const assetType = adapter.getAssetType()

    let ohlcv = await getCachedOHLCV(normalizedSymbol, assetType, 120)
    if (!ohlcv) {
      ohlcv = await adapter.fetchOHLCV(normalizedSymbol, 120)
      if (ohlcv.length === 0) return c.json({ error: `找不到標的：${normalizedSymbol}` }, 404)
      await upsertOHLCV(normalizedSymbol, assetType, ohlcv).catch(() => {})
    }

    const closes = ohlcv.map(b => b.close)
    const ma25   = computeMA(closes, 25)
    const ma60   = computeMA(closes, 60)
    const result = analyzeSymbol(ohlcv)
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
    }

    const analysis = await analyzeChart(data, body.question)
    return c.json({ analysis })
  } catch (err) {
    console.error("[ai/analyze]", err)
    return c.json({ error: "分析失敗，請稍後再試" }, 500)
  }
})
