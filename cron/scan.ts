/**
 * Daily signal scanner — runs after market close via GitHub Actions.
 *
 * For each active WatchlistAlert, fetches fresh OHLCV, checks for
 * a cross AT THE LAST BAR (detectCross, lookback=1), and pushes a
 * notification to LINE or Telegram if the user has that alert enabled.
 *
 * Uses detectCross (not findRecentSignal) so each cross fires exactly once.
 */

import { db } from "../src/db.js"
import { getAdapter } from "../src/adapters/index.js"
import { computeMA, scoreSignal } from "../src/engine/index.js"
import { getCachedOHLCV, upsertOHLCV } from "../src/cache.js"
import { pushLine, pushTelegram } from "./notify.js"

export async function runScan() {
  const alerts = await db.watchlistAlert.findMany({
    where: { active: true },
    include: { watchlist: true },
  })

  console.log(`Scanning ${alerts.length} watchlist alerts...`)

  for (const alert of alerts) {
    const { watchlist } = alert
    try {
      const { adapter, normalizedSymbol } = getAdapter(watchlist.symbol)

      // Try cache first; fall back to live fetch and repopulate cache
      let ohlcv = await getCachedOHLCV(normalizedSymbol, watchlist.asset_type, 90)
      if (!ohlcv) {
        ohlcv = await adapter.fetchOHLCV(normalizedSymbol, 90)
        await upsertOHLCV(normalizedSymbol, watchlist.asset_type, ohlcv)
      }

      const closes = ohlcv.map(b => b.close)
      const ma25   = computeMA(closes, 25)
      const ma60   = computeMA(closes, 60)

      // scoreSignal with lookback=1: only fire if cross happened at the last bar
      const { signal, confidence } = scoreSignal(ohlcv, ma25, ma60, 1)

      if (signal === "none") continue
      if (signal === "golden_cross" && !alert.on_golden) continue
      if (signal === "death_cross"  && !alert.on_death)  continue

      const latest = ohlcv[ohlcv.length - 1]

      // Dedup: skip if we already sent this exact signal for today's bar
      const alreadySent = await db.signalHistory.findFirst({
        where: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal },
      })
      if (alreadySent) continue
      const emoji  = signal === "golden_cross" ? "🟢" : "🔴"
      const label  = signal === "golden_cross" ? "黃金交叉" : "死亡交叉"
      const confLabel = confidence === "high" ? " 高信心度" : ""
      const msg    = `${emoji} ${watchlist.label ?? watchlist.symbol} ${label}${confLabel}\n收盤 ${latest.close}  日期 ${latest.date}`

      if (watchlist.platform === "line") {
        await pushLine(watchlist.user_id, msg)
      } else {
        await pushTelegram(watchlist.user_id, msg)
      }

      // Persist to signal history (upsert to avoid duplicates)
      await db.signalHistory.upsert({
        where: { symbol_signal_date_signal: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal } },
        create: {
          symbol:      normalizedSymbol,
          asset_type:  watchlist.asset_type,
          signal,
          signal_date: new Date(latest.date),
          close_price: latest.close,
          ma25:        (ma25[ma25.length - 1] ?? 0) as number,
          ma60:        (ma60[ma60.length - 1] ?? 0) as number,
          confidence,
        },
        update: {},
      })

      console.log(`  ✓ ${normalizedSymbol} → ${signal}`)
    } catch (err) {
      console.error(`  ✗ ${watchlist.symbol}:`, err)
    }
  }

  console.log("Scan complete.")
}
