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
import { analyzeChart } from "../src/services/ai.js"
import { pushLine, pushTelegram } from "./notify.js"
import type { ChartData } from "../src/engine/types.js"

async function push(platform: string, userId: string, msg: string) {
  if (platform === "line") await pushLine(userId, msg)
  else await pushTelegram(userId, msg)
}

export async function runMorningSummary() {
  if (!process.env.GROQ_API_KEY) {
    console.log("GROQ_API_KEY not set — skipping morning summary")
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

  let totalUsers = 0
  let totalSymbolsSent = 0

  for (const [, userAlerts] of byUser) {
    const { user_id, platform } = userAlerts[0].watchlist
    const lines: string[] = []

    for (const alert of userAlerts) {
      const { watchlist } = alert
      try {
        const { normalizedSymbol } = getAdapter(watchlist.symbol)

        const ohlcv = await getCachedOHLCV(normalizedSymbol, watchlist.asset_type, 90)
        if (!ohlcv || ohlcv.length < 65) continue  // skip if no cached data

        const closes = ohlcv.map(b => b.close)
        const ma25   = computeMA(closes, 25)
        const ma60   = computeMA(closes, 60)
        const { signal, confidence } = scoreSignal(ohlcv, ma25, ma60, 3)

        // Only include symbols with active cross signal (not "none")
        if (signal === "none") continue

        const chartData: ChartData = {
          symbol:      normalizedSymbol,
          asset_type:  watchlist.asset_type,
          ohlcv,
          ma25,
          ma60,
          signal,
          confidence,
          signal_date: null,
          support:     [],
          resistance:  [],
        }

        const analysis = await analyzeChart(chartData, "早安。用一到兩句話告訴我這個標的今天的操作方向，以及是否接近好的進出場時機。")
        lines.push(`• ${watchlist.label ?? normalizedSymbol}\n  ${analysis}`)
      } catch (err) {
        console.error(`  ✗ morning summary for ${watchlist.symbol}:`, err)
      }
    }

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
