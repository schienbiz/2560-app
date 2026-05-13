/**
 * Daily signal scanner — runs after market close via GitHub Actions.
 *
 * For each active WatchlistAlert:
 *  1. Cross event — if golden_cross or death_cross fired today, send AI message (fallback: raw)
 *  2. Proximity alert — if fast MA > slow MA (golden cross env) and price within threshold of
 *     fast MA, alert
 *  3. Zone exit — if price exits zone (>3% from fast MA) after a proximity_golden in last 3 days
 */

import { db } from "../src/db.js"
import { getAdapter } from "../src/adapters/index.js"
import { computeMA, scoreSignal } from "../src/engine/index.js"
import { getOrFetchOHLCV, fetchDaysFor } from "../src/utils/ohlcv.js"
import { analyzeChart } from "../src/services/ai.js"
import { pushLine, pushTelegram } from "./notify.js"
import type { ChartData } from "../src/engine/types.js"

const EXIT_THRESHOLD = 0.03    // 3% — zone is "closed"
const APP_URL        = "https://two560-app.onrender.com"

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
    const fastPeriod = alert.fast_period
    const slowPeriod = alert.slow_period
    const maLabel    = `MA${fastPeriod}/MA${slowPeriod}`

    try {
      const { adapter, normalizedSymbol } = getAdapter(watchlist.symbol)
      const assetType = watchlist.asset_type
      const days = fetchDaysFor(slowPeriod, assetType)

      const ohlcv = await getOrFetchOHLCV(normalizedSymbol, assetType, days, adapter)
      const closes = ohlcv.map(b => b.close)

      // Bar guard: skip if insufficient history for the configured slow period
      if (closes.length < slowPeriod + 5) {
        console.warn(`  ⚠ ${normalizedSymbol} insufficient_data: ${closes.length} bars < ${slowPeriod + 5} needed`)
        continue
      }

      const maFast = computeMA(closes, fastPeriod)
      const maSlow = computeMA(closes, slowPeriod)

      const maFastLast = maFast[maFast.length - 1] as number
      const maSlowLast = maSlow[maSlow.length - 1] as number

      // scoreSignal with lookback=1: only fire if cross happened at the last bar
      const { signal, confidence } = scoreSignal(ohlcv, maFast, maSlow, 1)
      const latest = ohlcv[ohlcv.length - 1]

      const chartData: ChartData = {
        symbol:      normalizedSymbol,
        asset_type:  assetType,
        ohlcv,
        ma25:        maFast,   // ChartData field names kept for compatibility (D2 decision)
        ma60:        maSlow,
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
            const crossLabel = signal === "golden_cross" ? "黃金交叉" : "死亡交叉"
            let msg: string
            try {
              msg = await analyzeChart(chartData) + deepLink(normalizedSymbol)
            } catch (err) {
              console.error(`  AI failed for ${normalizedSymbol} cross:`, err)
              const emoji     = signal === "golden_cross" ? "🟢" : "🔴"
              const confLabel = confidence === "high" ? " 高信心度" : ""
              msg = `${emoji} ${watchlist.label ?? watchlist.symbol} ${maLabel} ${crossLabel}${confLabel}\n收盤 ${latest.close}  日期 ${latest.date}` + deepLink(normalizedSymbol)
            }

            await push(watchlist.platform, watchlist.user_id, msg)

            await db.signalHistory.upsert({
              where: { symbol_signal_date_signal: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal } },
              create: {
                symbol:      normalizedSymbol,
                asset_type:  assetType,
                signal,
                signal_date: new Date(latest.date),
                close_price: latest.close,
                ma25:        maFastLast,
                ma60:        maSlowLast,
                confidence,
              },
              update: {},
            })

            console.log(`  ✓ ${normalizedSymbol} → ${signal}`)
          }
        }
      }

      // ── 2. Proximity alert (runs regardless of whether a cross fired today) ───
      // Only in golden cross environment (fast MA above slow MA)
      try {
        if (maFastLast && maSlowLast && maFastLast > maSlowLast && alert.on_golden) {
          const proximityThreshold = alert.proximity_threshold
          const priceDist = Math.abs(latest.close - maFastLast) / maFastLast

          if (priceDist <= proximityThreshold) {
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
                  `價格目前距離 MA${fastPeriod} 僅 ${(priceDist * 100).toFixed(2)}%，接近 ${maLabel} 策略理想進場區。請分析此時進場的風險報酬，以及 MA${fastPeriod} 支撐強度。`,
                ) + deepLink(normalizedSymbol)
              } catch (err) {
                console.error(`  AI failed for ${normalizedSymbol} proximity:`, err)
                proximityMsg = `📍 ${watchlist.label ?? watchlist.symbol} 接近 MA${fastPeriod} 進場區\n距 MA${fastPeriod} 僅 ${(priceDist * 100).toFixed(2)}%，趨勢向上，留意進場時機。收盤 ${latest.close}` + deepLink(normalizedSymbol)
              }

              await push(watchlist.platform, watchlist.user_id, proximityMsg)

              await db.signalHistory.upsert({
                where: { symbol_signal_date_signal: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal: "proximity_golden" } },
                create: {
                  symbol:      normalizedSymbol,
                  asset_type:  assetType,
                  signal:      "proximity_golden",
                  signal_date: new Date(latest.date),
                  close_price: latest.close,
                  ma25:        maFastLast,
                  ma60:        maSlowLast,
                  confidence,
                },
                update: {},
              })

              console.log(`  ✓ ${normalizedSymbol} → proximity_golden`)
            }
          }

          // ── 3. Zone exit alert ──────────────────────────────────────────────
          // Price has moved >3% away from fast MA after being in the zone
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
                const exitMsg = `🔔 ${watchlist.label ?? watchlist.symbol} 已離開進場區\n收盤 ${latest.close}，距 MA${fastPeriod} ${(priceDist * 100).toFixed(2)}%，進場窗口已關閉。` + deepLink(normalizedSymbol)

                await push(watchlist.platform, watchlist.user_id, exitMsg)

                await db.signalHistory.upsert({
                  where: { symbol_signal_date_signal: { symbol: normalizedSymbol, signal_date: new Date(latest.date), signal: "proximity_exit" } },
                  create: {
                    symbol:      normalizedSymbol,
                    asset_type:  assetType,
                    signal:      "proximity_exit",
                    signal_date: new Date(latest.date),
                    close_price: latest.close,
                    ma25:        maFastLast,
                    ma60:        maSlowLast,
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
