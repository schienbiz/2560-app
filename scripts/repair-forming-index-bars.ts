/**
 * One-off repair for the forming index bars written on 2026-09-08.
 *
 * BACKGROUND
 * `bulkInsertOHLCV` uses `createMany({ skipDuplicates: true })`, so a row it
 * writes can never be corrected by a later fetch. The benchmark-index refresh
 * added in v1.7.0 runs from the daily outcome cron — nominally 10:00 UTC, but
 * GitHub actually started it at 14:12 UTC (previous starts 13:26 and 15:33),
 * routinely after the 13:30 US open. Yahoo returns the session's still-forming
 * candle, so SPY's mid-session price was stored as the 2026-09-08 close:
 *
 *     cached 766.395   (fetched 14:12:53 UTC)
 *     actual 765.960
 *
 * 0050.TW was fetched at 04:47 UTC with the Taiwan session still open and
 * stored a provisional bar the source no longer reports at all.
 *
 * v1.7.3 stops it happening again (`settledBarsOnly`). This removes the two
 * poisoned rows and clears the benchmark values derived from them so the next
 * outcome pass recomputes from settled data — that pass only ever FILLS nulls,
 * never overwrites, which is exactly why the values must be nulled here.
 *
 * Only the index series is repaired: the watchlist symbols go through
 * `upsertOHLCV`, which updates on conflict and therefore self-heals.
 *
 * USAGE
 *   npx tsx scripts/repair-forming-index-bars.ts           # dry run (default)
 *   npx tsx scripts/repair-forming-index-bars.ts --apply
 *
 * Idempotent: a second run finds nothing.
 */

import { db } from "../src/db.js"
import { getAdapter } from "../src/adapters/index.js"
import { marketIndexSymbol } from "../src/utils/strong-death.js"
import type { MarketBucket } from "../src/utils/strong-death.js"

const APPLY = process.argv.includes("--apply")
/** The only day the faulty code ran before it was fixed. */
const POISONED_DAY = "2026-09-08"

async function main() {
  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (pass --apply to execute) ===")

  const indexes = (["tw", "us", "crypto"] as MarketBucket[]).map(b => marketIndexSymbol(b).symbol)
  console.log(`index series: ${indexes.join(", ")}\n`)

  // ── 1. Which cached index bars disagree with the settled source? ──────────
  const suspect: string[] = []
  for (const symbol of indexes) {
    const rows: Array<{ close: number; fetched_at: Date }> = await db.$queryRawUnsafe(
      `SELECT close, fetched_at FROM "OhlcvCache" WHERE symbol = $1 AND date = $2::date`,
      symbol, POISONED_DAY)
    if (rows.length === 0) { console.log(`  ${symbol.padEnd(9)} no ${POISONED_DAY} row — nothing to repair`); continue }

    const { adapter } = getAdapter(symbol)
    const live = await adapter.fetchOHLCV(symbol, 15).catch(() => [])
    const truth = live.find(b => b.date === POISONED_DAY)

    if (!truth) {
      console.log(`  ${symbol.padEnd(9)} cached ${rows[0].close} but the SOURCE HAS NO SUCH BAR → phantom, delete`)
      suspect.push(symbol)
    } else if (Math.abs(truth.close - rows[0].close) > 1e-9) {
      console.log(`  ${symbol.padEnd(9)} cached ${rows[0].close} vs settled ${truth.close}` +
                  ` (diff ${(truth.close - rows[0].close).toFixed(4)}) → forming snapshot, delete`)
      suspect.push(symbol)
    } else {
      console.log(`  ${symbol.padEnd(9)} cached ${rows[0].close} matches the settled close — leaving it`)
    }
  }

  // ── 2. Which benchmark values could have been derived from those bars? ────
  // A row's benchmark window is [signal_date, signal_date + 33d]; anything whose
  // window covers the poisoned day may have priced against it.
  const affected: Array<{ id: string; symbol: string; signal: string; d: string }> =
    await db.$queryRawUnsafe(`
      SELECT id, symbol, signal::text AS signal, signal_date::text AS d
      FROM "SignalHistory"
      -- signal_date is a timestamp, not a date: Postgres has no
      -- timestamp + integer operator, so the window arithmetic needs the cast.
      WHERE signal IN ('golden_cross','death_cross')
        AND signal_date::date <= $1::date
        AND (signal_date::date + 33) >= $1::date
        AND (benchmark_5d IS NOT NULL OR benchmark_10d IS NOT NULL OR benchmark_20d IS NOT NULL)
      ORDER BY signal_date`, POISONED_DAY)

  console.log(`\nbenchmark values to clear for recomputation: ${affected.length}`)
  for (const r of affected) console.log(`  ${r.symbol.padEnd(10)} ${r.signal.padEnd(13)} ${r.d.slice(0, 10)}`)

  if (!APPLY) { await db.$disconnect(); return }

  for (const symbol of suspect) {
    const del = await db.ohlcvCache.deleteMany({ where: { symbol, date: new Date(POISONED_DAY) } })
    console.log(`\ndeleted ${del.count} row(s) for ${symbol} ${POISONED_DAY}`)
  }
  if (affected.length > 0) {
    const upd = await db.signalHistory.updateMany({
      where: { id: { in: affected.map(r => r.id) } },
      data: { benchmark_5d: null, benchmark_10d: null, benchmark_20d: null },
    })
    console.log(`cleared benchmarks on ${upd.count} signal row(s) — the next outcome pass refills them`)
  }

  const left: Array<{ n: number }> = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "OhlcvCache" WHERE symbol = ANY($1) AND date = $2::date`,
    suspect, POISONED_DAY)
  console.log(`\nVerify: ${left[0].n === 0 ? "✅ poisoned index rows gone" : `❌ ${left[0].n} still present`}`)

  await db.$disconnect()
}

main().catch(err => { console.error("REPAIR FAILED:", err); process.exit(1) })
