/**
 * Outcome cron — % return at +5/+10/+20 trading days after each golden/death
 * cross, plus the market-index (BTC/SPY/0050) return over the same windows.
 * The raw-vs-benchmark split is what lets signal stats separate "the signal
 * worked" from "the whole market moved".
 *
 * Runs once daily and revisits rows until they are complete. The previous
 * one-shot design keyed eligibility on `outcome_computed_at: null` and ran at
 * +10 calendar days — when only the 5d window had matured — so outcome_10d and
 * outcome_20d stayed null forever. Eligibility is now data-driven: any row
 * aged between ELIGIBLE_AGE_DAYS and STALE_AGE_DAYS whose 20d outcome or 20d
 * benchmark is still null gets (re)processed; each pass fills only fields that
 * are still null and never overwrites a stored value. Rows older than
 * STALE_AGE_DAYS keep whatever they have — a delisted symbol (or an index
 * window the cache never covered) would otherwise be re-scanned daily forever.
 *
 * `outcome_computed_at` now means "last computation attempt"; its only readers
 * (routes/signals.ts, routes/ai.ts) use it as a has-outcomes `{ not: null }`
 * filter, which is unaffected.
 */

import { db } from "../src/db.js"
import { getAdapter } from "../src/adapters/index.js"
import { bulkInsertOHLCV } from "../src/cache.js"
import { getMarket, marketIndexSymbol } from "../src/utils/strong-death.js"
import type { MarketBucket } from "../src/utils/strong-death.js"
import { addDays, benchmarkBase, windowReturns, WINDOW_END_CAL_DAYS } from "../src/utils/outcome-math.js"

const ELIGIBLE_AGE_DAYS = 10   // ensures the +5-trading-day (≈7 cal) window has matured
const STALE_AGE_DAYS    = 120  // beyond this, missing windows are accepted as permanently missing

/** Buckets whose index series this cron is responsible for keeping current. */
const BENCHMARK_BUCKETS: MarketBucket[] = ["tw", "us", "crypto"]
/** Deep enough to cover the whole eligibility window plus its +33d horizon. */
const INDEX_HISTORY_DAYS = STALE_AGE_DAYS + WINDOW_END_CAL_DAYS + 47   // 200

/**
 * Pull current bars for BTCUSDT / SPY / 0050.TW into the cache.
 *
 * WHY THIS RUNS HERE. The benchmark columns read `OhlcvCache` directly and
 * never fetch — and nothing else fetched an index either: index bars only ever
 * arrived as a side effect of `evaluateStrongDeath()`, which runs exclusively
 * on a bar where a DEATH CROSS fires. So an index froze the moment its market
 * stopped producing death crosses. Measured in production on 2026-09-07,
 * SPY's newest cached bar was 2026-07-21 (48 days old) and 0050.TW's was
 * 2026-08-14 (24 days old) — and every one of the 19 crosses missing
 * `benchmark_20d` sits after its own index's last bar: US after 07-21, TW
 * after 08-14, an exact match. That gap was read as "data availability" on
 * 2026-09-02 and it is what failed the Phase 1 A/E report's §1 coverage gate.
 * Left alone, those rows age past STALE_AGE_DAYS and are abandoned unfilled.
 *
 * Three HTTP calls a day. Each index is independent: one dead source must not
 * stop the fill loop, so failures are reported and the pass continues on
 * whatever the cache already holds.
 */
async function refreshBenchmarkIndexes(): Promise<string[]> {
  const failed: string[] = []
  await Promise.allSettled(BENCHMARK_BUCKETS.map(async bucket => {
    const { symbol } = marketIndexSymbol(bucket)
    try {
      const { adapter } = getAdapter(symbol)
      const bars = await adapter.fetchOHLCV(symbol, INDEX_HISTORY_DAYS)
      if (bars.length === 0) {
        failed.push(symbol)
        console.warn(`  ⚠ index ${symbol}: no bars returned`)
        return
      }
      await bulkInsertOHLCV(symbol, adapter.getSource(), bars)
      console.log(`  ↻ index ${symbol}: ${bars.length} bars through ${bars[bars.length - 1].date}`)
    } catch (err) {
      failed.push(symbol)
      console.warn(`  ⚠ index ${symbol} refresh failed:`, (err as Error).message)
    }
  }))
  return failed
}

export interface OutcomeRunResult {
  /** Rows the eligibility query returned this pass. */
  pending: number
  /** Rows whose recomputation threw. */
  failed: number
  /** Index symbols that could not be refreshed this pass. */
  indexRefreshFailed: string[]
}

export async function runOutcome(): Promise<OutcomeRunResult> {
  const now = new Date()

  // Indexes first — the benchmark half of the fill loop reads them straight
  // out of the cache and cannot fetch on its own.
  const indexRefreshFailed = await refreshBenchmarkIndexes()

  const pending = await db.signalHistory.findMany({
    where: {
      signal: { in: ["golden_cross", "death_cross"] },
      signal_date: { lte: addDays(now, -ELIGIBLE_AGE_DAYS), gte: addDays(now, -STALE_AGE_DAYS) },
      OR: [{ outcome_20d: null }, { benchmark_20d: null }],
    },
    orderBy: { signal_date: "asc" },
    take: 100,
  })

  console.log(`Computing outcomes for ${pending.length} signal entries...`)

  let failed = 0

  // Process in parallel batches of 10 to avoid DB connection pool pressure
  const BATCH = 10
  for (let i = 0; i < pending.length; i += BATCH) {
    await Promise.allSettled(pending.slice(i, i + BATCH).map(async entry => {
      try {
        const signalDate = new Date(entry.signal_date)
        const windowEnd  = addDays(signalDate, WINDOW_END_CAL_DAYS)
        const idx        = marketIndexSymbol(getMarket(entry.asset_type, entry.symbol))

        const barsInWindow = (symbol: string) => db.ohlcvCache.findMany({
          where: { symbol, date: { gte: signalDate, lte: windowEnd } },
          orderBy: { date: "asc" },
          select: { date: true, close: true },
        })
        const [priceRows, idxRows] = await Promise.all([
          barsInWindow(entry.symbol),
          barsInWindow(idx.symbol),
        ])

        const sym     = windowReturns(priceRows, entry.close_price, signalDate)
        const idxBase = benchmarkBase(idxRows, signalDate)
        const bench   = idxBase != null
          ? windowReturns(idxRows, idxBase, signalDate)
          : { d5: null, d10: null, d20: null }

        // ?? keeps any previously stored value — passes only fill gaps
        const merged = {
          outcome_5d:    entry.outcome_5d    ?? sym.d5,
          outcome_10d:   entry.outcome_10d   ?? sym.d10,
          outcome_20d:   entry.outcome_20d   ?? sym.d20,
          benchmark_5d:  entry.benchmark_5d  ?? bench.d5,
          benchmark_10d: entry.benchmark_10d ?? bench.d10,
          benchmark_20d: entry.benchmark_20d ?? bench.d20,
        }
        await db.signalHistory.update({
          where: { id: entry.id },
          data: { ...merged, outcome_computed_at: new Date() },
        })

        const fmt = (v: number | null) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "N/A"
        console.log(`  ✓ ${entry.symbol} ${String(entry.signal_date).slice(0, 10)} ${entry.signal}: 5d=${fmt(merged.outcome_5d)} 10d=${fmt(merged.outcome_10d)} 20d=${fmt(merged.outcome_20d)} 大盤20d=${fmt(merged.benchmark_20d)}`)
      } catch (err) {
        failed++
        console.error(`  ✗ ${entry.symbol} ${entry.id}:`, err)
      }
    }))
  }

  console.log(`Outcome computation complete. pending=${pending.length} failed=${failed}` +
              (indexRefreshFailed.length ? ` indexRefreshFailed=${indexRefreshFailed.join(",")}` : ""))
  return { pending: pending.length, failed, indexRefreshFailed }
}
