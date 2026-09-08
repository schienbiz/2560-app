/**
 * One-off data migration: collapse alias symbols onto their canonical form.
 *
 * BACKGROUND
 * `getAdapter()` is synchronous and only upper-cased its input, so a Taiwan
 * code was persisted exactly as typed while YahooFinanceAdapter resolved the
 * exchange suffix internally at fetch time. Two spellings of one stock became
 * two independent keys everywhere:
 *   - OhlcvCache held "2330" (503 bars) and "2330.TW" (503 bars), every close
 *     identical — two Yahoo fetches and two row sets per scan.
 *   - SignalHistory recorded every 2330 event TWICE, so win-rate stats counted
 *     one stock as two.
 *   - One user held both "5230" and "5230.TW" → two pushes per cross.
 * Worse, the stored suffix could be wrong outright: probing Yahoo shows 5230,
 * 8937 and 3176 list on TPEx (.TWO) while the rows said ".TW" or nothing.
 *
 * `src/utils/symbol.ts::resolveSymbol` now canonicalises at every write. This
 * script fixes the rows written before that existed.
 *
 * The alias→canonical map is DERIVED by probing the live data source, never
 * hard-coded, and a symbol whose exchange cannot be confirmed is skipped rather
 * than guessed.
 *
 * USAGE
 *   npx tsx scripts/migrate-canonical-symbols.ts           # dry run (default)
 *   npx tsx scripts/migrate-canonical-symbols.ts --apply   # execute
 *
 * Idempotent: a second run finds nothing to do.
 */

import { db } from "../src/db.js"
import { resolveSymbol } from "../src/utils/symbol.js"

const APPLY = process.argv.includes("--apply")

/** Every symbol string that appears anywhere in the database. */
async function allSymbols(): Promise<string[]> {
  const rows: Array<{ symbol: string }> = await db.$queryRawUnsafe(`
    SELECT DISTINCT symbol FROM (
      SELECT symbol FROM "Watchlist"
      UNION SELECT symbol FROM "SignalHistory"
      UNION SELECT symbol FROM "OhlcvCache"
      UNION SELECT symbol FROM "TradeRecord"
      UNION SELECT symbol FROM "RemindMe"
    ) x ORDER BY symbol`)
  return rows.map(r => r.symbol)
}

async function buildAliasMap(symbols: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const s of symbols) {
    const r = await resolveSymbol(s)
    if (!r.resolved) {
      console.log(`  ? ${s.padEnd(12)} exchange unconfirmed — SKIPPED (never guess a suffix)`)
      continue
    }
    if (r.symbol !== s) map.set(s, r.symbol)
  }
  return map
}

/** OhlcvCache is pure cache: copy what the canonical key lacks, drop the alias. */
async function migrateCache(alias: string, canonical: string) {
  const aliasRows = await db.ohlcvCache.findMany({ where: { symbol: alias } })
  if (aliasRows.length === 0) return { copied: 0, deleted: 0 }

  const existing = await db.ohlcvCache.findMany({
    where: { symbol: canonical }, select: { date: true },
  })
  const have = new Set(existing.map(r => r.date.toISOString().slice(0, 10)))
  const missing = aliasRows.filter(r => !have.has(r.date.toISOString().slice(0, 10)))

  if (!APPLY) return { copied: missing.length, deleted: aliasRows.length }

  if (missing.length > 0) {
    await db.ohlcvCache.createMany({
      data: missing.map(r => ({
        symbol: canonical, source: r.source, date: r.date,
        open: r.open, high: r.high, low: r.low, close: r.close,
        volume: r.volume, fetched_at: r.fetched_at,
      })),
      skipDuplicates: true,
    })
  }
  const del = await db.ohlcvCache.deleteMany({ where: { symbol: alias } })
  return { copied: missing.length, deleted: del.count }
}

/**
 * SignalHistory: repoint where the canonical key is free; where BOTH spellings
 * recorded the same event, fold any value the survivor is missing into it and
 * drop the duplicate. Only null fields are filled — a stored number is never
 * overwritten, so this cannot rewrite history.
 */
async function migrateSignals(alias: string, canonical: string) {
  const rows = await db.signalHistory.findMany({ where: { symbol: alias } })
  let moved = 0, merged = 0

  for (const r of rows) {
    const twin = await db.signalHistory.findUnique({
      where: { symbol_signal_date_signal: { symbol: canonical, signal_date: r.signal_date, signal: r.signal } },
    })

    if (!twin) {
      if (APPLY) await db.signalHistory.update({ where: { id: r.id }, data: { symbol: canonical } })
      moved++
      continue
    }

    const fill = {
      outcome_5d:        twin.outcome_5d        ?? r.outcome_5d,
      outcome_10d:       twin.outcome_10d       ?? r.outcome_10d,
      outcome_20d:       twin.outcome_20d       ?? r.outcome_20d,
      benchmark_5d:      twin.benchmark_5d      ?? r.benchmark_5d,
      benchmark_10d:     twin.benchmark_10d     ?? r.benchmark_10d,
      benchmark_20d:     twin.benchmark_20d     ?? r.benchmark_20d,
      strong_passed:     twin.strong_passed     ?? r.strong_passed,
      strong_applicable: twin.strong_applicable ?? r.strong_applicable,
      outcome_computed_at: twin.outcome_computed_at ?? r.outcome_computed_at,
    }
    if (APPLY) {
      await db.signalHistory.update({ where: { id: twin.id }, data: fill })
      // A trade referencing the row we are about to delete must follow it.
      await db.tradeRecord.updateMany({ where: { signal_id: r.id }, data: { signal_id: twin.id } })
      await db.signalHistory.delete({ where: { id: r.id } })
    }
    merged++
  }
  return { moved, merged }
}

/** Watchlist: repoint, unless the same user already holds the canonical row. */
async function migrateWatchlist(alias: string, canonical: string) {
  const rows = await db.watchlist.findMany({
    where: { symbol: alias }, orderBy: { created_at: "asc" },
  })
  let moved = 0, dropped = 0

  for (const r of rows) {
    const twin = await db.watchlist.findFirst({
      where: { user_id: r.user_id, platform: r.platform, symbol: canonical },
    })
    if (twin) {
      // Same person, same stock, two spellings — the duplicate is what caused
      // the double push. Keep the canonical row (cascade removes the alert).
      if (APPLY) await db.watchlist.delete({ where: { id: r.id } })
      dropped++
    } else {
      if (APPLY) await db.watchlist.update({ where: { id: r.id }, data: { symbol: canonical } })
      moved++
    }
  }
  return { moved, dropped }
}

async function main() {
  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (pass --apply to execute) ===")

  const symbols = await allSymbols()
  console.log(`\n${symbols.length} distinct symbols in the database. Resolving…`)
  const aliases = await buildAliasMap(symbols)

  if (aliases.size === 0) {
    console.log("\nNothing to migrate — every symbol is already canonical.")
    await db.$disconnect()
    return
  }

  console.log(`\n${aliases.size} alias(es) to collapse:`)
  for (const [a, c] of aliases) console.log(`  ${a.padEnd(12)} → ${c}`)

  console.log("")
  for (const [alias, canonical] of aliases) {
    const cache = await migrateCache(alias, canonical)
    const sig   = await migrateSignals(alias, canonical)
    const wl    = await migrateWatchlist(alias, canonical)
    const rm    = APPLY
      ? (await db.remindMe.updateMany({ where: { symbol: alias }, data: { symbol: canonical } })).count
      : await db.remindMe.count({ where: { symbol: alias } })
    const tr    = APPLY
      ? (await db.tradeRecord.updateMany({ where: { symbol: alias }, data: { symbol: canonical } })).count
      : await db.tradeRecord.count({ where: { symbol: alias } })

    console.log(
      `${alias.padEnd(12)} → ${canonical.padEnd(12)} ` +
      `cache(+${cache.copied}/-${cache.deleted})  ` +
      `signals(moved ${sig.moved}, merged ${sig.merged})  ` +
      `watchlist(moved ${wl.moved}, dropped ${wl.dropped})  ` +
      `reminders(${rm})  trades(${tr})`
    )
  }

  // ── Data hygiene: OhlcvCache.source records the FEED, not the asset type ──
  // Every caller used to pass `assetType` into the `source` parameter, so the
  // column held "stock"/"crypto" (11157/994 rows) — a duplicate of asset_type
  // and no help at all when tracing which feed produced bad bars. The adapters
  // now supply getSource(); this repairs the rows written before that.
  const legacySource: Array<[string, string]> = [["stock", "yahoo"], ["crypto", "kraken"]]
  for (const [from, to] of legacySource) {
    const n = APPLY
      ? (await db.ohlcvCache.updateMany({ where: { source: from }, data: { source: to } })).count
      : await db.ohlcvCache.count({ where: { source: from } })
    if (n > 0) console.log(`\nsource "${from}" → "${to}": ${n} rows`)
  }

  if (APPLY) {
    const left = await allSymbols()
    const stillAliased = [...aliases.keys()].filter(a => left.includes(a))
    console.log(`\nVerify: ${stillAliased.length === 0 ? "✅ no alias symbols remain" : `❌ still present: ${stillAliased.join(", ")}`}`)
    console.log("Remaining symbols:", left.join(", "))
    console.log("\nNext: npx tsx scripts/seed-notification-claims.ts --apply")
  }

  await db.$disconnect()
}

main().catch(err => { console.error("MIGRATION FAILED:", err); process.exit(1) })
