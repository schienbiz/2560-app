/**
 * Daily signal scanner — runs after market close via GitHub Actions.
 *
 * For each active WatchlistAlert:
 *  1. Cross event — if golden_cross or death_cross fired today, send AI message (fallback: raw)
 *  2. Proximity alert — if MA25 > MA60 (golden cross env) and price within 1.5% of MA25, alert
 *  3. Zone exit — if price exits zone (>3% from MA25) after a proximity_golden in last 3 days, alert
 */

import { db } from "../src/db.js"
import { getAdapter } from "../src/adapters/index.js"
import { computeMA, scoreSignal } from "../src/engine/index.js"
import { getCachedOHLCV, upsertOHLCV } from "../src/cache.js"
import { analyzeChart } from "../src/services/ai.js"
import { pushLine, pushTelegram } from "./notify.js"
import type { ChartData } from "../src/engine/types.js"

const PROXIMITY_THRESHOLD = 0.015   // 1.5% — tune after real data
const EXIT_THRESHOLD      = 0.03    // 3% — zone is "closed"
const APP_URL             = "https://two560-app.onrender.com"

function deepLink(symbol: string): string {
  return `\n${APP_URL}/?symbol=${encodeURIComponent(symbol)}`
}

async function push(platform: string, userId: string, msg: string) {
  if (platform === "line") await pushLine(userId, msg)
  else await pushTelegram(userId, msg)
}

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

      const ma25Last = ma25[ma25.length - 1] as number
      const ma60Last = ma60[ma60.length - 1] as number

      // scoreSignal with lookback=1: only fire if cross happened at the last bar
      const { signal, confidence } = scoreSignal(ohlcv, ma25, ma60, 1)
      const latest = ohlcv[ohlcv.length - 1]

      const chartData: ChartData = {
        symbol:      normalizedSymbol,
        asset_type:  watchlist.asset_type,
        ohlcv,
        ma25,
        ma60,
        signal,
        confidence,
        signal_date: latest.date,
        support:     [],
        resistance:  [],
      }

      // ── 1. Cross event ────────────────────────────────────────────────────────
      if (signal !== "none") {
        if (signal === "golden_cross" && alert.on_golden || signal === "death_cross" && alert.on_death) {
          const alreadySent = await db.signalHistory.findFirst({
            where: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal },
          })

          if (!alreadySent) {
            let msg: string
            try {
              msg = await analyzeChart(chartData) + deepLink(normalizedSymbol)
            } catch (err) {
              console.error(`  AI failed for ${normalizedSymbol} cross:`, err)
              const emoji     = signal === "golden_cross" ? "🟢" : "🔴"
              const label     = signal === "golden_cross" ? "黃金交叉" : "死亡交叉"
              const confLabel = confidence === "high" ? " 高信心度" : ""
              msg = `${emoji} ${watchlist.label ?? watchlist.symbol} ${label}${confLabel}\n收盤 ${latest.close}  日期 ${latest.date}` + deepLink(normalizedSymbol)
            }

            await push(watchlist.platform, watchlist.user_id, msg)

            await db.signalHistory.upsert({
              where: { symbol_signal_date_signal: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal } },
              create: {
                symbol:      normalizedSymbol,
                asset_type:  watchlist.asset_type,
                signal,
                signal_date: new Date(latest.date),
                close_price: latest.close,
                ma25:        ma25Last,
                ma60:        ma60Last,
                confidence,
              },
              update: {},
            })

            console.log(`  ✓ ${normalizedSymbol} → ${signal}`)
          }
        }
      }

      // ── 2. Proximity alert (runs regardless of whether a cross fired today) ───
      // Only in golden cross environment (MA25 above MA60)
      try {
        if (ma25Last && ma60Last && ma25Last > ma60Last && alert.on_golden) {
          const priceDist = Math.abs(latest.close - ma25Last) / ma25Last

          if (priceDist <= (alert.proximity_threshold ?? PROXIMITY_THRESHOLD)) {
            const today = new Date()
            today.setHours(0, 0, 0, 0)

            const alreadyAlerted = await db.signalHistory.findFirst({
              where: {
                symbol:      normalizedSymbol,
                signal_date: { gte: today },
                signal:      "proximity_golden",
              },
            })

            if (!alreadyAlerted) {
              let proximityMsg: string
              try {
                proximityMsg = await analyzeChart(
                  chartData,
                  `價格目前距離 MA25 僅 ${(priceDist * 100).toFixed(2)}%，接近 2560戰法理想進場區。請分析此時進場的風險報酬，以及 MA25 支撐強度。`,
                ) + deepLink(normalizedSymbol)
              } catch (err) {
                console.error(`  AI failed for ${normalizedSymbol} proximity:`, err)
                proximityMsg = `📍 ${watchlist.label ?? watchlist.symbol} 接近 MA25 進場區\n距 MA25 僅 ${(priceDist * 100).toFixed(2)}%，趨勢向上，留意進場時機。收盤 ${latest.close}` + deepLink(normalizedSymbol)
              }

              await push(watchlist.platform, watchlist.user_id, proximityMsg)

              await db.signalHistory.upsert({
                where: { symbol_signal_date_signal: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal: "proximity_golden" } },
                create: {
                  symbol:      normalizedSymbol,
                  asset_type:  watchlist.asset_type,
                  signal:      "proximity_golden",
                  signal_date: new Date(latest.date),
                  close_price: latest.close,
                  ma25:        ma25Last,
                  ma60:        ma60Last,
                  confidence,
                },
                update: {},
              })

              console.log(`  ✓ ${normalizedSymbol} → proximity_golden`)
            }
          }

          // ── 3. Zone exit alert ──────────────────────────────────────────────
          // Price has moved >3% away from MA25 after being in the zone
          if (priceDist > EXIT_THRESHOLD) {
            const threeDaysAgo = new Date()
            threeDaysAgo.setDate(threeDaysAgo.getDate() - 3)
            threeDaysAgo.setHours(0, 0, 0, 0)

            const recentProximity = await db.signalHistory.findFirst({
              where: {
                symbol:      normalizedSymbol,
                signal:      "proximity_golden",
                signal_date: { gte: threeDaysAgo },
              },
            })

            if (recentProximity) {
              const today = new Date()
              today.setHours(0, 0, 0, 0)

              const alreadyExited = await db.signalHistory.findFirst({
                where: {
                  symbol:      normalizedSymbol,
                  signal_date: { gte: today },
                  signal:      "proximity_exit",
                },
              })

              if (!alreadyExited) {
                const exitMsg = `🔔 ${watchlist.label ?? watchlist.symbol} 已離開進場區\n收盤 ${latest.close}，距 MA25 ${(priceDist * 100).toFixed(2)}%，進場窗口已關閉。` + deepLink(normalizedSymbol)

                await push(watchlist.platform, watchlist.user_id, exitMsg)

                await db.signalHistory.upsert({
                  where: { symbol_signal_date_signal: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal: "proximity_exit" } },
                  create: {
                    symbol:      normalizedSymbol,
                    asset_type:  watchlist.asset_type,
                    signal:      "proximity_exit",
                    signal_date: new Date(latest.date),
                    close_price: latest.close,
                    ma25:        ma25Last,
                    ma60:        ma60Last,
                    confidence,
                  },
                  update: {},
                })

                console.log(`  ✓ ${normalizedSymbol} → proximity_exit`)
              }
            }
          }
        }
      } catch (err) {
        console.error(`  ✗ proximity block for ${watchlist.symbol}:`, err)
      }

    } catch (err) {
      console.error(`  ✗ ${watchlist.symbol}:`, err)
    }
  }

  console.log("Scan complete.")
}
