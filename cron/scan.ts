/**
 * Daily signal scanner — runs after market close via GitHub Actions.
 *
 * For each active WatchlistAlert:
 *  1. Cross event — if golden_cross or death_cross fired today, send AI message (fallback: raw)
 *  2. Proximity alert — if fast MA > slow MA (golden cross env) and price within threshold of
 *     fast MA, alert
 *  3. Zone exit — if price exits zone (>3% from fast MA) after a proximity_golden in last 3 days
 *
 * Performance: OHLCV is pre-fetched per unique symbol (not per alert), Fear & Greed is fetched
 * once, and all alerts are processed in parallel via Promise.allSettled.
 */

import { db } from "../src/db.js"
import { getAdapter } from "../src/adapters/index.js"
import { computeMA, scoreSignal, hasSufficientBars, formatStrongDeathLine, FACTOR_COUNT } from "../src/engine/index.js"
import { getOrFetchOHLCV, fetchDaysFor } from "../src/utils/ohlcv.js"
import { claimNotification, releaseNotification } from "../src/utils/notify-dedup.js"
import { evaluateStrongDeath, getMarket } from "../src/utils/strong-death.js"
import type { MarketBucket } from "../src/utils/strong-death.js"
import { notifyInsight } from "../src/services/ai.js"
import { fetchFearGreed, scoreFearGreed } from "../src/services/news.js"
import type { SentimentResult } from "../src/services/news.js"
import { deliver, maskRecipient } from "./notify.js"
import type { ChartData } from "../src/engine/types.js"
import type { OHLCV, AssetType } from "../src/engine/types.js"

const EXIT_THRESHOLD = 0.03    // 3% — zone is "closed"
const APP_URL        = process.env.APP_URL ?? "https://two560-app.onrender.com"

type Market = MarketBucket

// getMarket moved to src/utils/strong-death.ts (cron/outcome.ts needs it for
// benchmark routing); re-exported here so existing imports keep working.
export { getMarket }

// Smart MACD formatter: large values (BTC) get 0-2 decimals, small (alt) get 4-6
function fmtMacd(v: number): string {
  const abs = Math.abs(v)
  const dec = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return (v >= 0 ? "+" : "") + v.toFixed(dec)
}

// Price for notification text: Yahoo returns raw floats (333.260009765625) that
// read like garbage in a push message. ≥1 gets 2 decimals, sub-1 alts get 6.
export function fmtPrice(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1 ? 2 : 6 })
}

/**
 * Action line for a cross notification.
 *
 * A death cross is a SELL signal in the 2560 strategy, but the old copy pasted
 * the golden-cross「進場區…停損」line under both crosses — telling the user
 * where to BUY into a bearish cross. Golden keeps the entry zone; death frames
 * the same MA band as rebound-trim resistance instead.
 */
export function crossActionLine(
  signal: "golden_cross" | "death_cross",
  fastPeriod: number,
  slowPeriod: number,
  maFast: number,
  maSlow: number
): string {
  const low  = fmtPrice(maFast * 0.99)
  const high = fmtPrice(maFast * 1.01)
  return signal === "golden_cross"
    ? `進場區 ${low}–${high}，跌破 ${fmtPrice(maSlow)}（MA${slowPeriod}）停損`
    : `死叉為出場訊號：反彈至 ${low}–${high}（MA${fastPeriod}）視為減碼壓力區`
}

function deepLink(symbol: string): string {
  return `\n${APP_URL}/?symbol=${encodeURIComponent(symbol)}`
}

// Delivery — and the handling of a recipient who can never receive again —
// lives in cron/notify.ts::deliver, so all three crons behave identically.

export interface ScanRunResult {
  /** Alerts selected for this market bucket. */
  alerts: number
  /** Distinct symbols the scan had to price. */
  symbols: number
  /** Notifications actually delivered. */
  notified: number
  /**
   * Symbols whose bars could not be obtained AT ALL this run.
   *
   * This is the number that matters. The scan reads each symbol once a day and
   * `scoreSignal(..., lookback=1)` only fires on the LAST bar's transition, so
   * a symbol missing here does not merely get a late answer: by tomorrow the
   * cross is no longer the last bar and it is never detected. Until now this
   * was a lone `console.warn` inside a Promise.allSettled — the endpoint still
   * returned `{ok:true}` and the workflow still went green, so a day of Yahoo
   * throttling silently cost signals with no symptom anywhere.
   */
  fetchFailed: string[]
  /** Alerts whose processing threw after the bars were in hand. */
  alertFailed: number
  /** Symbols deliberately skipped: too few bars to trust a slow-MA cross. */
  insufficientData: string[]
  /**
   * Recipients switched off this run because they can never receive again —
   * they blocked the bot, or their id is not addressable at all. Reported but
   * deliberately NOT counted as a failure: counting them would turn every scan
   * red for as long as one blocked chat remains on the watchlist, and a
   * dead-man alert that fires daily stops being read.
   */
  deactivated: string[]
}

export async function runScan(markets?: Market[]): Promise<ScanRunResult> {
  const allAlerts = await db.watchlistAlert.findMany({
    where: { active: true },
    include: { watchlist: true },
  })

  const alerts = markets
    ? allAlerts.filter(a => markets.includes(getMarket(a.watchlist.asset_type, a.watchlist.symbol)))
    : allAlerts

  const marketLabel = markets ? ` [${markets.join(",")}]` : ""
  console.log(`Scanning ${alerts.length}/${allAlerts.length} watchlist alerts${marketLabel}...`)
  const empty: ScanRunResult = {
    alerts: 0, symbols: 0, notified: 0, fetchFailed: [], alertFailed: 0, insufficientData: [], deactivated: [],
  }
  if (alerts.length === 0) { console.log("Scan complete."); return empty }

  // ── Pre-fetch 1: OHLCV for each unique symbol (max slow_period across all alerts) ──
  // Avoids fetching the same symbol N times when multiple users watch it.
  type SymbolMeta = { maxDays: number; assetType: AssetType }
  const symbolMeta = new Map<string, SymbolMeta>()
  for (const alert of alerts) {
    const { normalizedSymbol } = getAdapter(alert.watchlist.symbol)
    const assetType = alert.watchlist.asset_type
    const days = fetchDaysFor(alert.slow_period, assetType)
    const existing = symbolMeta.get(normalizedSymbol)
    if (!existing) {
      symbolMeta.set(normalizedSymbol, { maxDays: days, assetType })
    } else if (days > existing.maxDays) {
      existing.maxDays = days
    }
  }

  const ohlcvMap    = new Map<string, OHLCV[]>()
  const fetchFailed: string[] = []
  await Promise.allSettled([...symbolMeta.entries()].map(async ([sym, meta]) => {
    try {
      const { adapter } = getAdapter(sym)
      const ohlcv = await getOrFetchOHLCV(sym, meta.assetType, meta.maxDays, adapter)
      if (ohlcv.length > 0) ohlcvMap.set(sym, ohlcv)
      else fetchFailed.push(sym)
    } catch (err) {
      fetchFailed.push(sym)
      console.error(`  ✗ fetch ${sym}: ${(err as Error).message}`)
    }
  }))

  // ── Pre-fetch 2: Fear & Greed once for all crypto alerts (has 1h in-memory cache) ──
  const fearGreed = await fetchFearGreed().catch(() => null)

  // ── Process all alerts in parallel ───────────────────────────────────────────────
  let notified = 0
  let alertFailed = 0
  const insufficientData = new Set<string>()
  const deactivated = new Set<string>()

  await Promise.allSettled(alerts.map(async alert => {
    const { watchlist } = alert
    const fastPeriod = alert.fast_period
    const slowPeriod = alert.slow_period

    try {
      const { normalizedSymbol } = getAdapter(watchlist.symbol)
      const assetType = watchlist.asset_type
      const ohlcv = ohlcvMap.get(normalizedSymbol)

      if (!ohlcv || ohlcv.length === 0) {
        console.warn(`  ⚠ ${normalizedSymbol} no OHLCV data`)
        return
      }

      const closes = ohlcv.map(b => b.close)

      // Bar guard: skip if insufficient history for the configured slow period
      if (!hasSufficientBars(closes.length, slowPeriod)) {
        insufficientData.add(normalizedSymbol)
        console.warn(`  ⚠ ${normalizedSymbol} insufficient_data: ${closes.length} bars < ${slowPeriod + 5} needed`)
        return
      }

      const maFast = computeMA(closes, fastPeriod)
      const maSlow = computeMA(closes, slowPeriod)

      const maFastLast = maFast[maFast.length - 1] as number
      const maSlowLast = maSlow[maSlow.length - 1] as number

      // scoreSignal with lookback=1: only fire if cross happened at the last bar
      const { signal, confidence, rsi, macdHist } = scoreSignal(ohlcv, maFast, maSlow, 1)
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
        rsi,
        macdHist,
      }

      // ── 1. Cross event ──────────────────────────────────────────────────────────
      if (signal !== "none") {
        if (signal === "golden_cross" && alert.on_golden || signal === "death_cross" && alert.on_death) {
          // Per-USER claim, not a global "has this cross been recorded" check.
          // The old query hit SignalHistory, which is one row per (symbol, date,
          // signal) for the whole system — so with two people watching the same
          // symbol the first one processed took the row and the others were
          // skipped. Claiming an idempotency key also removes the read-then-
          // write race the old check depended on to work at all.
          const key = {
            userId: watchlist.user_id, platform: watchlist.platform,
            symbol: normalizedSymbol, signalDate: new Date(latest.date), signal,
          }
          const claimed = await claimNotification(key)

          if (claimed) {
            try {
              const crossLabel = signal === "golden_cross" ? "黃金交叉" : "死亡交叉"
              const emoji      = signal === "golden_cross" ? "🟢" : "🔴"
              const confLabel  = confidence === "high" ? " 高信心度" : ""
              const arrow      = signal === "golden_cross" ? "↑" : "↓"

              // Use pre-fetched Fear & Greed (already cached)
              let sentiment: SentimentResult | undefined
              if (fearGreed && assetType === "crypto" && (signal === "golden_cross" || signal === "death_cross")) {
                sentiment = scoreFearGreed(fearGreed, signal)
              }

              // Strong-death evaluation runs concurrently with the AI insight call
              const [insight, strongDeath] = await Promise.all([
                notifyInsight(chartData, signal, fastPeriod, slowPeriod, sentiment),
                signal === "death_cross"
                  ? evaluateStrongDeath(normalizedSymbol, assetType, slowPeriod, getMarket(assetType, normalizedSymbol), latest.date)
                  : Promise.resolve(null),
              ])
              // 83% precision claim only for the backtested MA25/60 configuration
              const strongLine = strongDeath
                ? formatStrongDeathLine(strongDeath, fastPeriod === 25 && slowPeriod === 60)
                : null

              // RSI + MACD summary line
              const rsiStr  = rsi != null      ? `RSI ${rsi.toFixed(1)}` : null
              const macdStr = macdHist != null ? `MACD柱 ${fmtMacd(macdHist)}` : null
              const indLine = [rsiStr, macdStr].filter(Boolean).join(" · ")

              // Sentiment line (crypto only)
              const sentLine = sentiment
                ? `情緒 ${sentiment.score === 1 ? "📈 正面" : sentiment.score === -1 ? "📉 負面" : "➖ 中性"} · ${sentiment.summary}`
                : null

              const msg = [
                `${emoji} ${watchlist.label ?? watchlist.symbol} ${crossLabel}${confLabel}`,
                strongLine,
                `MA${fastPeriod} ${maFastLast.toFixed(2)} ${arrow} MA${slowPeriod} ${maSlowLast.toFixed(2)} · 收盤 ${fmtPrice(latest.close)}`,
                indLine,
                sentLine,
                crossActionLine(signal, fastPeriod, slowPeriod, maFastLast, maSlowLast),
                insight,
              ].filter(Boolean).join("\n") + deepLink(normalizedSymbol)

              if (await deliver(watchlist.platform, watchlist.user_id, msg) === "sent") notified++
              else { deactivated.add(`${watchlist.platform}:${maskRecipient(watchlist.user_id)}`); await releaseNotification(key) }

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
                  // Persisted at signal time so live precision per confirmation
                  // tier can later be measured against the backtest claim.
                  strong_passed:     strongDeath?.passed,
                  strong_applicable: strongDeath?.applicable,
                },
                update: {},
              })

              console.log(`  ✓ ${normalizedSymbol} → ${signal}${strongDeath ? ` (死叉確認 ${strongDeath.passed}/${FACTOR_COUNT}${strongDeath.isStrong ? " ⚡強確認" : ""})` : ""}`)
            } catch (err) {
              // Hand the claim back so a re-run can retry rather than the
              // notification being lost to a transient push failure.
              await releaseNotification(key)
              throw err
            }
          }
        }
      }

      // ── 2. Proximity alert (runs regardless of whether a cross fired today) ─────
      // Only in golden cross environment (fast MA above slow MA)
      try {
        if (maFastLast && maSlowLast && maFastLast > maSlowLast && alert.on_golden) {
          const proximityThreshold = alert.proximity_threshold
          const priceDist = Math.abs(latest.close - maFastLast) / maFastLast

          if (priceDist <= proximityThreshold) {
            // Dedup on the bar's own (UTC) date — same basis as the signal_date we write,
            // so it's timezone-independent. The old `gte today(Taipei)` never matched its
            // own writes for US symbols (scanned at 22:00 UTC = Taipei next day), making
            // the US proximity dedup a no-op that could re-alert on any same-day re-run.
            // Now also per-user, for the same reason as the cross event above.
            const proxKey = {
              userId: watchlist.user_id, platform: watchlist.platform,
              symbol: normalizedSymbol, signalDate: new Date(latest.date),
              signal: "proximity_golden" as const,
            }

            if (await claimNotification(proxKey)) {
              try {
                const entryLow  = (maFastLast * 0.99).toLocaleString(undefined, { maximumFractionDigits: 2 })
                const entryHigh = (maFastLast * 1.01).toLocaleString(undefined, { maximumFractionDigits: 2 })
                const stopLine  = maSlowLast.toLocaleString(undefined, { maximumFractionDigits: 2 })
                const insight   = await notifyInsight(chartData, "proximity_golden", fastPeriod, slowPeriod)

                const proxRsi  = rsi != null      ? `RSI ${rsi.toFixed(1)}` : null
                const proxMacd = macdHist != null ? `MACD柱 ${fmtMacd(macdHist)}` : null
                const proxInd  = [proxRsi, proxMacd].filter(Boolean).join(" · ")

                const proximityMsg = [
                  `📍 ${watchlist.label ?? watchlist.symbol} 接近 MA${fastPeriod} 進場區`,
                  `距 MA${fastPeriod} 僅 ${(priceDist * 100).toFixed(2)}% · 收盤 ${fmtPrice(latest.close)}`,
                  proxInd,
                  `進場區 ${entryLow}–${entryHigh}，跌破 ${stopLine} 停損`,
                  insight,
                ].filter(Boolean).join("\n") + deepLink(normalizedSymbol)

                if (await deliver(watchlist.platform, watchlist.user_id, proximityMsg) === "sent") notified++
                else { deactivated.add(`${watchlist.platform}:${maskRecipient(watchlist.user_id)}`); await releaseNotification(proxKey) }

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
              } catch (err) {
                await releaseNotification(proxKey)
                throw err
              }
            }
          }

          // ── 3. Zone exit alert ────────────────────────────────────────────────
          // Price has moved >3% away from fast MA after being in the zone
          if (priceDist > EXIT_THRESHOLD) {
            // 3-day lookback anchored on the bar's UTC date (same basis as stored
            // signal_date) → timezone-independent window.
            const threeDaysAgo = new Date(latest.date)
            threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3)

            const recentProximity = await db.signalHistory.findFirst({
              where: {
                symbol:      normalizedSymbol,
                signal:      "proximity_golden",
                signal_date: { gte: threeDaysAgo },
              },
            })

            if (recentProximity) {
              const exitKey = {
                userId: watchlist.user_id, platform: watchlist.platform,
                symbol: normalizedSymbol, signalDate: new Date(latest.date),
                signal: "proximity_exit" as const,
              }

              if (await claimNotification(exitKey)) {
                try {
                  const exitMsg = `🔔 ${watchlist.label ?? watchlist.symbol} 已離開進場區\n收盤 ${fmtPrice(latest.close)}，距 MA${fastPeriod} ${(priceDist * 100).toFixed(2)}%，進場窗口已關閉。` + deepLink(normalizedSymbol)

                  if (await deliver(watchlist.platform, watchlist.user_id, exitMsg) === "sent") notified++
                  else { deactivated.add(`${watchlist.platform}:${maskRecipient(watchlist.user_id)}`); await releaseNotification(exitKey) }

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
                } catch (err) {
                  await releaseNotification(exitKey)
                  throw err
                }
              }
            }
          }
        }
      } catch (err) {
        alertFailed++
        console.error(`  ✗ proximity block for ${watchlist.symbol}:`, err)
      }

    } catch (err) {
      alertFailed++
      console.error(`  ✗ ${watchlist.symbol}:`, err)
    }
  }))

  const result: ScanRunResult = {
    alerts:           alerts.length,
    symbols:          symbolMeta.size,
    notified,
    fetchFailed,
    alertFailed,
    insufficientData: [...insufficientData],
    deactivated:      [...deactivated],
  }
  console.log(
    `Scan complete. alerts=${result.alerts} symbols=${result.symbols} notified=${result.notified} ` +
    `alertFailed=${result.alertFailed}` +
    (fetchFailed.length ? ` fetchFailed=${fetchFailed.join(",")}` : "") +
    (result.insufficientData.length ? ` insufficientData=${result.insufficientData.join(",")}` : "") +
    (result.deactivated.length ? ` deactivated=${result.deactivated.join(",")}` : "")
  )
  return result
}
