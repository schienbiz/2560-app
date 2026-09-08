/**
 * Seed the SignalNotification ledger from what has already been sent.
 *
 * WHY. Notification dedup moved off SignalHistory (a global market fact) onto a
 * per-user ledger. The ledger starts empty, so on the first scan after deploy
 * every alert would look un-notified — and any signal still sitting on the last
 * bar would be pushed a second time to people who already received it.
 *
 * There is no record of exactly who was notified (that is the whole reason this
 * table now exists), so this seeds the conservative approximation: for every
 * SignalHistory row inside the recent window, claim it for every user who
 * currently watches that symbol on that platform. Over-claiming can at worst
 * suppress one duplicate; under-claiming would send one.
 *
 * RUN ORDER — after scripts/migrate-canonical-symbols.ts, so the symbols in
 * SignalHistory already match the symbols in Watchlist.
 *
 * USAGE
 *   npx tsx scripts/seed-notification-claims.ts           # dry run (default)
 *   npx tsx scripts/seed-notification-claims.ts --apply   # execute
 *
 * Idempotent: skipDuplicates means a second run inserts nothing.
 */

import { db } from "../src/db.js"

const APPLY = process.argv.includes("--apply")

/**
 * How far back to seed. A signal only fires a notification while it is on the
 * LAST bar, so anything older than a few days can no longer be re-sent; 14 days
 * is generous cover for a weekend plus a holiday plus a late deploy.
 */
const WINDOW_DAYS = 14

async function main() {
  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (pass --apply to execute) ===")

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const signals = await db.signalHistory.findMany({
    where: { signal_date: { gte: since } },
    select: { symbol: true, signal: true, signal_date: true },
  })
  const watchers = await db.watchlist.findMany({
    select: { user_id: true, platform: true, symbol: true },
  })
  console.log(`${signals.length} signals in the last ${WINDOW_DAYS} days × ${watchers.length} watchlist rows`)

  const bySymbol = new Map<string, typeof watchers>()
  for (const w of watchers) {
    if (!bySymbol.has(w.symbol)) bySymbol.set(w.symbol, [])
    bySymbol.get(w.symbol)!.push(w)
  }

  const rows = signals.flatMap(s =>
    (bySymbol.get(s.symbol) ?? []).map(w => ({
      user_id:     w.user_id,
      platform:    w.platform,
      symbol:      s.symbol,
      signal:      s.signal,
      signal_date: s.signal_date,
    }))
  )

  console.log(`${rows.length} claims to seed`)
  for (const s of [...new Set(signals.map(x => x.symbol))].sort()) {
    const n = rows.filter(r => r.symbol === s).length
    if (n > 0) console.log(`  ${s.padEnd(12)} ${n}`)
  }

  if (!APPLY) { await db.$disconnect(); return }

  const res = await db.signalNotification.createMany({ data: rows, skipDuplicates: true })
  const total = await db.signalNotification.count()
  console.log(`\ninserted=${res.count}  ledger total=${total}`)
  await db.$disconnect()
}

main().catch(err => { console.error("SEED FAILED:", err); process.exit(1) })
