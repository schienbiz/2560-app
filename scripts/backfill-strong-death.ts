/**
 * One-off backfill: recompute the 5-factor strong-death score for historical
 * death crosses recorded before strong_passed/strong_applicable existed
 * (migration 20260710090000). Run manually:
 *
 *   npx tsx scripts/backfill-strong-death.ts          # dry run
 *   npx tsx scripts/backfill-strong-death.ts --write  # persist
 *
 * Best-effort: factors are scored on today's cached/fetched bars truncated to
 * the cross bar, so a split or dividend adjustment since the cross can shift a
 * borderline factor vs what a live scan would have stored. Slow MA period is
 * taken from the symbol's current WatchlistAlert config (default 60).
 */

import { db } from "../src/db.js"
import { evaluateStrongDeath, getMarket } from "../src/utils/strong-death.js"

const WRITE = process.argv.includes("--write")

async function main() {
  const rows = await db.signalHistory.findMany({
    where: { signal: "death_cross", strong_passed: null },
    orderBy: { signal_date: "asc" },
  })
  console.log(`${rows.length} death crosses without strong-death score${WRITE ? "" : " (dry run — pass --write to persist)"}`)

  for (const r of rows) {
    const asOf = r.signal_date.toISOString().slice(0, 10)
    const alert = await db.watchlistAlert.findFirst({
      where: { watchlist: { symbol: r.symbol } },
      select: { slow_period: true },
    })
    const slowPeriod = alert?.slow_period ?? 60

    const res = await evaluateStrongDeath(r.symbol, r.asset_type, slowPeriod, getMarket(r.asset_type, r.symbol), asOf)
    if (!res) {
      console.log(`  ✗ ${r.symbol} ${asOf}: insufficient data, left null`)
      continue
    }
    if (WRITE) {
      await db.signalHistory.update({
        where: { id: r.id },
        data: { strong_passed: res.passed, strong_applicable: res.applicable },
      })
    }
    console.log(`  ✓ ${r.symbol} ${asOf} (MA${slowPeriod}): ${res.passed}/${res.applicable}${res.isStrong ? " ⚡強確認" : ""}`)
  }
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1) })
