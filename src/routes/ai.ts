/**
 * AI analysis route — requires auth.
 *
 * POST /api/ai/analyze/:symbol
 *   Body (optional): { "question": "現在可以進場嗎？" }
 *   Returns: { "analysis": "..." }
 */

import { Hono } from "hono"
import { authMiddleware } from "../auth.js"
import { analyzeChart, hasAnyProviderKey, type SignalHistoryEntry } from "../services/ai.js"
import { getAdapter } from "../adapters/index.js"
import { resolveSymbolForRead } from "../utils/symbol.js"
import { computeMA } from "../engine/index.js"
import { scoreSignal, hasSufficientBars } from "../engine/signal.js"
import { computeSR } from "../engine/sr.js"
import { getOrFetchOHLCV, fetchDaysFor } from "../utils/ohlcv.js"
import { db } from "../db.js"
import type { ChartData } from "../engine/types.js"

export const aiRouter = new Hono()
aiRouter.use("*", authMiddleware)

aiRouter.post("/analyze/:symbol", async c => {
  if (!hasAnyProviderKey()) return c.json({ error: "AI 功能尚未啟用" }, 503)

  const symbol = c.req.param("symbol").toUpperCase()
  const body   = await c.req.json<{ question?: string }>().catch(() => ({ question: undefined }))

  try {
    const { userId, platform } = c.get("user")
    // Canonicalise first. Two things depend on it: getOrFetchOHLCV writes
    // OhlcvCache under this key (a bare "2330" from a URL recreates the alias
    // the migration merged away), and the watchlist lookup below matches on it
    // — with the un-canonicalised form, `/api/ai/analyze/2330` silently failed
    // to find the now-"2330.TW" row and analysed the symbol against the default
    // MA25/60 instead of the periods the user had configured.
    const { symbol: normalizedSymbol, assetType } = await resolveSymbolForRead(symbol)
    const { adapter } = getAdapter(normalizedSymbol)

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
    const enough = hasSufficientBars(ohlcv.length, slowPeriod)
    const sr     = computeSR(ohlcv)

    const data: ChartData = {
      symbol:      normalizedSymbol,
      asset_type:  assetType,
      ohlcv,
      ma25,
      ma60,
      signal:      enough ? result.signal : "none",
      confidence:  enough ? result.confidence : "low",
      signal_date: enough && result.crossIndex !== null ? ohlcv[result.crossIndex]?.date ?? null : null,
      support:     sr.support,
      resistance:  sr.resistance,
      rsi:         result.rsi,
      macdHist:    result.macdHist,
      insufficient_history: !enough,
    }

    // Fetch historical signal outcomes for this symbol — gives AI real win rate context
    const historyRows = await db.signalHistory.findMany({
      where: {
        symbol: normalizedSymbol,
        signal: { in: ["golden_cross", "death_cross"] },
        outcome_computed_at: { not: null },
      },
      orderBy: { signal_date: "desc" },
      take: 10,
      select: {
        signal:      true,
        signal_date: true,
        confidence:  true,
        outcome_5d:  true,
        outcome_10d: true,
        outcome_20d: true,
      },
    }) satisfies SignalHistoryEntry[]

    const analysis = await analyzeChart(data, body.question, historyRows, fastPeriod, slowPeriod)
    return c.json({ analysis })
  } catch (err) {
    console.error("[ai/analyze]", err)
    return c.json({ error: "分析失敗，請稍後再試" }, 500)
  }
})
