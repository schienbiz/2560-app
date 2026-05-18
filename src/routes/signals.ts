/**
 * Signal routes — scoped to the authenticated user's watchlist symbols.
 *
 * GET /api/signals?limit=30
 *   Alert history — last N signal events.
 *
 * GET /api/signals/outcomes
 *   Win rates and average returns at +5/+10/+20 trading days per symbol/signal.
 *   Only includes signals where outcome_computed_at is set (cron/outcome.ts fills these).
 */

import { Hono } from "hono"
import { db } from "../db.js"
import { authMiddleware } from "../auth.js"

export const signalsRouter = new Hono()
signalsRouter.use("*", authMiddleware)

// Must be registered before "/" to avoid the wildcard swallowing it
signalsRouter.get("/outcomes", async c => {
  const { userId, platform } = c.get("user")

  try {
    const watchlist = await db.watchlist.findMany({
      where: { user_id: userId, platform },
      select: { symbol: true },
    })

    const symbols = watchlist.map(w => w.symbol)
    if (!symbols.length) return c.json({ outcomes: [] })

    const signals = await db.signalHistory.findMany({
      where: {
        symbol:             { in: symbols },
        signal:             { in: ["golden_cross", "death_cross"] },
        outcome_computed_at: { not: null },
      },
      select: {
        symbol:      true,
        signal:      true,
        outcome_5d:  true,
        outcome_10d: true,
        outcome_20d: true,
      },
    })

    // Aggregate win rates and average returns per (symbol, signal) pair
    type Acc = {
      symbol: string; signal: string
      wins5: number; tot5: number; sum5: number
      wins10: number; tot10: number; sum10: number
      wins20: number; tot20: number; sum20: number
    }
    const grouped = new Map<string, Acc>()

    for (const s of signals) {
      const key = `${s.symbol}|${s.signal}`
      if (!grouped.has(key)) {
        grouped.set(key, {
          symbol: s.symbol, signal: s.signal,
          wins5: 0, tot5: 0, sum5: 0,
          wins10: 0, tot10: 0, sum10: 0,
          wins20: 0, tot20: 0, sum20: 0,
        })
      }
      const g      = grouped.get(key)!
      const isLong = s.signal === "golden_cross"

      if (s.outcome_5d != null) {
        g.tot5++; g.sum5 += s.outcome_5d
        if (isLong ? s.outcome_5d > 0 : s.outcome_5d < 0) g.wins5++
      }
      if (s.outcome_10d != null) {
        g.tot10++; g.sum10 += s.outcome_10d
        if (isLong ? s.outcome_10d > 0 : s.outcome_10d < 0) g.wins10++
      }
      if (s.outcome_20d != null) {
        g.tot20++; g.sum20 += s.outcome_20d
        if (isLong ? s.outcome_20d > 0 : s.outcome_20d < 0) g.wins20++
      }
    }

    const outcomes = Array.from(grouped.values()).map(g => ({
      symbol:         g.symbol,
      signal:         g.signal,
      count:          g.tot20,
      win_rate_5d:    g.tot5  > 0 ? g.wins5  / g.tot5  : null,
      win_rate_10d:   g.tot10 > 0 ? g.wins10 / g.tot10 : null,
      win_rate_20d:   g.tot20 > 0 ? g.wins20 / g.tot20 : null,
      avg_return_5d:  g.tot5  > 0 ? g.sum5   / g.tot5  : null,
      avg_return_10d: g.tot10 > 0 ? g.sum10  / g.tot10 : null,
      avg_return_20d: g.tot20 > 0 ? g.sum20  / g.tot20 : null,
    }))

    return c.json({ outcomes })
  } catch {
    return c.json({ outcomes: [] })
  }
})

signalsRouter.get("/", async c => {
  const { userId, platform } = c.get("user")
  const limitParam = c.req.query("limit")
  const limit = Math.min(parseInt(limitParam ?? "30", 10) || 30, 100)

  try {
    const watchlist = await db.watchlist.findMany({
      where: { user_id: userId, platform },
      select: { symbol: true },
    })

    const symbols = watchlist.map(w => w.symbol)
    if (!symbols.length) return c.json({ signals: [] })

    const signals = await db.signalHistory.findMany({
      where: { symbol: { in: symbols } },
      orderBy: { signal_date: "desc" },
      take: limit,
    })

    return c.json({ signals })
  } catch {
    return c.json({ signals: [] })
  }
})
