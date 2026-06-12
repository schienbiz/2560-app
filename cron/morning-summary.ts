/**
 * Morning summary — runs at 8:00am Taipei time (00:00 UTC) via GitHub Actions.
 *
 * For each user with an active watchlist, generates a brief AI digest of every
 * symbol with an active cross signal. Uses cached OHLCV only (no live API calls
 * at 8am to avoid Render cold-start timeouts). If all symbols are quiet, sends a
 * single "everything calm" message instead of skipping.
 */

import { db } from "../src/db.js"
import { getAdapter } from "../src/adapters/index.js"
import { computeMA, scoreSignal } from "../src/engine/index.js"
import { getCachedOHLCV } from "../src/cache.js"
import { analyzeChart, type SignalHistoryEntry } from "../src/services/ai.js"
import { pushLine, pushTelegram } from "./notify.js"
import type { ChartData } from "../src/engine/types.js"

async function push(platform: string, userId: string, msg: string) {
  if (platform === "line") await pushLine(userId, msg)
  else await pushTelegram(userId, msg)
}

export async function runMorningSummary() {
  const hasKey = process.env.GROQ_API_KEY || process.env.CEREBRAS_API_KEY ||
                 process.env.NVIDIA_API_KEY || process.env.OPENROUTER_API_KEY
  if (!hasKey) {
    console.log("No AI API key set — skipping morning summary")
    return
  }

  const alerts = await db.watchlistAlert.findMany({
    where: { active: true },
    include: { watchlist: true },
    orderBy: [
      { watchlist: { user_id: "asc" } },
      { watchlist: { platform: "asc" } },
    ],
  })

  // Group by user
  const byUser = new Map<string, typeof alerts>()
  for (const alert of alerts) {
    const key = `${alert.watchlist.user_id}::${alert.watchlist.platform}`
    if (!byUser.has(key)) byUser.set(key, [])
    byUser.get(key)!.push(alert)
  }

  // Batch-fetch historical signal outcomes for all symbols — one query shared across all users
  const allSymbols = [...new Set(alerts.map(a => getAdapter(a.watchlist.symbol).normalizedSymbol))]
  const allHistory = allSymbols.length > 0 ? await db.signalHistory.findMany({
    where: {
      symbol:              { in: allSymbols },
      signal:              { in: ["golden_cross", "death_cross"] },
      outcome_computed_at: { not: null },
    },
    orderBy: { signal_date: "desc" },
    take: allSymbols.length * 10,
    select: { symbol: true, signal: true, signal_date: true, confidence: true, outcome_5d: true, outcome_10d: true, outcome_20d: true },
  }) satisfies SignalHistoryEntry[] : []

  // Index by symbol for O(1) lookup per alert
  const historyBySymbol = new Map<string, SignalHistoryEntry[]>()
  for (const row of allHistory) {
    if (!historyBySymbol.has(row.symbol)) historyBySymbol.set(row.symbol, [])
    const arr = historyBySymbol.get(row.symbol)!
    if (arr.length < 10) arr.push(row)
  }

  let totalUsers = 0
  let totalSymbolsSent = 0

  for (const [, userAlerts] of byUser) {
    const { user_id, platform } = userAlerts[0].watchlist
    // Process all symbols for this user concurrently
    const results = await Promise.allSettled(userAlerts.map(async alert => {
      const { watchlist } = alert
      const fastPeriod = alert.fast_period
      const slowPeriod = alert.slow_period
      const { normalizedSymbol } = getAdapter(watchlist.symbol)

      // Fetch enough history for the configured slow period
      const minBars = slowPeriod + 30
      const cacheDays = Math.max(120, Math.ceil(minBars * (watchlist.asset_type === "crypto" ? 1 : 1.45)))
      const ohlcv = await getCachedOHLCV(normalizedSymbol, watchlist.asset_type, cacheDays)
      if (!ohlcv || ohlcv.length < slowPeriod + 5) return null

      const closes = ohlcv.map(b => b.close)
      const maFast = computeMA(closes, fastPeriod)
      const maSlow = computeMA(closes, slowPeriod)
      const { signal, confidence, rsi, macdHist } = scoreSignal(ohlcv, maFast, maSlow, 3)

      if (signal === "none") return null

      const chartData: ChartData = {
        symbol:      normalizedSymbol,
        asset_type:  watchlist.asset_type,
        ohlcv,
        ma25:        maFast,
        ma60:        maSlow,
        signal,
        confidence,
        signal_date: null,
        support:     [],
        resistance:  [],
        rsi,
        macdHist,
      }

      const history = historyBySymbol.get(normalizedSymbol)
      const analysis = await analyzeChart(chartData, "早安。用一到兩句話告訴我這個標的今天的操作方向，以及是否接近好的進出場時機。", history)
      return `• ${watchlist.label ?? normalizedSymbol}\n  ${analysis}`
    }))

    const lines: string[] = results
      .map(r => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is string => v !== null)

    const msg = lines.length > 0
      ? `🌅 2560戰法 早安摘要\n\n${lines.join("\n\n")}`
      : "🌅 今天自選股全部平靜，沒有活躍的黃金交叉或死亡交叉訊號。"

    try {
      await push(platform, user_id, msg)
      totalUsers++
      totalSymbolsSent += lines.length
      console.log(`  ✓ Morning summary → ${user_id} (${platform}), ${lines.length} symbols`)
    } catch (err) {
      console.error(`  ✗ Push failed for ${user_id}:`, err)
    }
  }

  console.log(`Morning summary complete. Sent to ${totalUsers} users, ${totalSymbolsSent} symbols total.`)
}
