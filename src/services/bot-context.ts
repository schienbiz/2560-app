/**
 * Shared bot context loader — used by LINE and Telegram webhook handlers.
 */

import { db } from "../db.js"
import type { BotContext } from "./ai.js"

export async function getUserContext(
  userId:   string,
  platform: "line" | "telegram",
): Promise<BotContext> {
  const [watchlistItems, recentTrades] = await Promise.all([
    db.watchlist.findMany({
      where:   { user_id: userId, platform },
      select:  { symbol: true },
      orderBy: { created_at: "desc" },
      take:    10,
    }),
    db.tradeRecord.findMany({
      where:   { user_id: userId, platform },
      orderBy: { entry_date: "desc" },
      take:    5,
    }),
  ])

  // Batch-query the latest signal for each watchlist symbol in one query
  const symbols = watchlistItems.map((w: { symbol: string }) => w.symbol)
  const latestSignals = symbols.length > 0 ? await db.signalHistory.findMany({
    where:    { symbol: { in: symbols }, signal: { in: ["golden_cross", "death_cross"] } },
    orderBy:  { signal_date: "desc" },
    distinct: ["symbol"],
    select:   { symbol: true, signal: true, signal_date: true },
  }) : []
  const signalMap = new Map(latestSignals.map(s => [s.symbol, s.signal as string]))

  return {
    watchlist: watchlistItems.map((w: { symbol: string }) => ({
      symbol: w.symbol,
      signal: signalMap.get(w.symbol),
    })),
    recentTrades: recentTrades.map((t: { symbol: string; direction: string; entry_price: number; exit_price: number | null }) => ({
      symbol:      t.symbol,
      direction:   t.direction,
      entry_price: t.entry_price,
      exit_price:  t.exit_price,
    })),
  }
}
