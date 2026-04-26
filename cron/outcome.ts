/**
 * Outcome cron — computes % return at +5/+10/+20 trading days after each signal.
 *
 * Runs once daily. For each golden/death cross SignalHistory entry that lacks
 * outcomes and is old enough, finds the first OhlcvCache bar on or after each
 * target date and records the % change from the signal's close_price.
 *
 * Target windows (calendar days to approximate trading days):
 *   +5 trading  ≈ start looking 7 cal days out (search window: 5 cal days)
 *   +10 trading ≈ start looking 14 cal days out
 *   +20 trading ≈ start looking 28 cal days out
 */

import { db } from "../src/db.js"

async function fetchBarOnOrAfter(symbol: string, afterDate: Date, searchWindowDays = 5): Promise<number | null> {
  const to = new Date(afterDate)
  to.setDate(to.getDate() + searchWindowDays)

  const row = await db.ohlcvCache.findFirst({
    where: { symbol, date: { gte: afterDate, lte: to } },
    orderBy: { date: "asc" },
  })
  return row?.close ?? null
}

export async function runOutcome() {
  const now = new Date()

  // Only process signals where signal_date is ≥10 calendar days ago
  // (ensures at least 5 trading days of data will exist)
  const eligibilityCutoff = new Date(now)
  eligibilityCutoff.setDate(eligibilityCutoff.getDate() - 10)

  const pending = await db.signalHistory.findMany({
    where: {
      outcome_computed_at: null,
      signal_date: { lte: eligibilityCutoff },
      signal: { in: ["golden_cross", "death_cross"] },
    },
    orderBy: { signal_date: "asc" },
    take: 100,
  })

  console.log(`Computing outcomes for ${pending.length} signal entries...`)

  for (const entry of pending) {
    try {
      const base       = entry.close_price
      const signalDate = new Date(entry.signal_date)

      const target5  = new Date(signalDate); target5.setDate(target5.getDate() + 7)
      const target10 = new Date(signalDate); target10.setDate(target10.getDate() + 14)
      const target20 = new Date(signalDate); target20.setDate(target20.getDate() + 28)

      const [price5, price10, price20] = await Promise.all([
        fetchBarOnOrAfter(entry.symbol, target5),
        fetchBarOnOrAfter(entry.symbol, target10),
        fetchBarOnOrAfter(entry.symbol, target20),
      ])

      const pct = (p: number | null): number | null =>
        p != null ? (p - base) / base * 100 : null

      await db.signalHistory.update({
        where: { id: entry.id },
        data: {
          outcome_5d:          pct(price5),
          outcome_10d:         pct(price10),
          outcome_20d:         pct(price20),
          outcome_computed_at: new Date(),
        },
      })

      const fmt = (v: number | null) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : "N/A"
      console.log(`  ✓ ${entry.symbol} ${String(entry.signal_date).slice(0, 10)} ${entry.signal}: 5d=${fmt(pct(price5))} 10d=${fmt(pct(price10))} 20d=${fmt(pct(price20))}`)
    } catch (err) {
      console.error(`  ✗ ${entry.symbol} ${entry.id}:`, err)
    }
  }

  console.log("Outcome computation complete.")
}
