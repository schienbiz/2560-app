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
import { computeMA, scoreSignal, hasSufficientBars } from "../src/engine/index.js"
import { getCachedOHLCVByBarAge } from "../src/cache.js"
import { fetchDaysFor } from "../src/utils/ohlcv.js"
import { morningInsight, hasAnyProviderKey, type SignalHistoryEntry } from "../src/services/ai.js"
import { deliver, maskRecipient } from "./notify.js"
import { fmtPrice } from "./scan.js"
import type { ChartData } from "../src/engine/types.js"

// Delivery (and the handling of a recipient who can never receive again) lives
// in cron/notify.ts so all three crons behave identically.

export async function runMorningSummary() {
  if (!hasAnyProviderKey()) {
    console.log("No AI API key set — skipping morning summary")
    return { users: 0, symbols: 0, failed: 0, skipped: "no-ai-key" as const }
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
  // Counted and returned, not just logged: the /internal endpoint reports it so
  // the GitHub workflow can fail on a run where every push was rejected.
  let failedPushes = 0
  // Recipients switched off this run because they can never receive again.
  // Reported but deliberately NOT a failure — see cron/notify.ts::deliver.
  const deactivated: string[] = []

  for (const [, userAlerts] of byUser) {
    const { user_id, platform } = userAlerts[0].watchlist
    // Process all symbols for this user concurrently
    const results = await Promise.allSettled(userAlerts.map(async alert => {
      const { watchlist } = alert
      const fastPeriod = alert.fast_period
      const slowPeriod = alert.slow_period
      const { normalizedSymbol } = getAdapter(watchlist.symbol)

      // Enough history for the configured slow period. Uses the shared
      // fetchDaysFor rather than a second hand-rolled 1.45 conversion — the
      // real ratio is TRADING_TO_CALENDAR (1.4484) and two copies drift.
      const cacheDays = Math.max(120, fetchDaysFor(slowPeriod, watchlist.asset_type))
      // Bar-age freshness, NOT fetch-age. This cron deliberately never fetches
      // (00:00 UTC is a Render cold start), and the fetch-age rule made crypto
      // permanently invisible here — see getCachedOHLCVByBarAge.
      const ohlcv = await getCachedOHLCVByBarAge(normalizedSymbol, watchlist.asset_type, cacheDays)
      if (!ohlcv || !hasSufficientBars(ohlcv.length, slowPeriod)) return null

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
      const insight = await morningInsight(chartData, fastPeriod, slowPeriod, history)

      // Header carries the signal + data-as-of date: the GH cron regularly
      // fires 2–4 h late, so「早安」can land mid-session — the reader must be
      // able to see the advice is based on the previous close, not a live tick.
      const lastBar  = ohlcv[ohlcv.length - 1]
      const sigBadge = signal === "golden_cross" ? "🟢 黃金交叉" : "🔴 死亡交叉"
      // fmtPrice, not the raw float: Yahoo hands back 333.260009765625, which
      // reads like garbage in a push. (The cross notifications already went
      // through fmtPrice; this AI-failure fallback line was the one path left
      // printing the raw value.)
      const fallback = `收盤 ${fmtPrice(lastBar.close)}，MA${fastPeriod} ${maFast[maFast.length - 1]?.toFixed(2)} / MA${slowPeriod} ${maSlow[maSlow.length - 1]?.toFixed(2)}`
      return `• ${watchlist.label ?? normalizedSymbol} ${sigBadge}（資料至 ${lastBar.date}）\n  ${insight || fallback}`
    }))

    const lines: string[] = results
      .map(r => (r.status === "fulfilled" ? r.value : null))
      .filter((v): v is string => v !== null)

    const msg = lines.length > 0
      ? `🌅 2560戰法 早安摘要\n\n${lines.join("\n\n")}`
      : "🌅 今天自選股全部平靜，沒有活躍的黃金交叉或死亡交叉訊號。"

    try {
      const outcome = await deliver(platform, user_id, msg)
      if (outcome === "deactivated") {
        // Permanently unreachable — switched off, reported, and NOT counted as
        // a failure. Counting it would fail this run every single day and turn
        // the dead-man alert into noise.
        deactivated.push(`${platform}:${maskRecipient(user_id)}`)
        continue
      }
      totalUsers++
      totalSymbolsSent += lines.length
      console.log(`  ✓ Morning summary → ${user_id} (${platform}), ${lines.length} symbols`)
    } catch (err) {
      failedPushes++
      console.error(`  ✗ Push failed for ${user_id}:`, err)
    }
  }

  console.log(`Morning summary complete. Sent to ${totalUsers} users, ${totalSymbolsSent} symbols total, ` +
              `${failedPushes} transient failures` +
              (deactivated.length ? `, deactivated ${deactivated.join(", ")}` : "") + ".")
  return { users: totalUsers, symbols: totalSymbolsSent, failed: failedPushes, deactivated }
}
