/**
 * Alert history — last 30 signal events for the authenticated user's watchlist.
 *
 * GET /api/signals?limit=30
 *
 * SignalHistory has no user_id column. We scope to the user's watchlist symbols
 * so each user only sees alerts for symbols they're watching.
 */

import { Hono } from "hono"
import { db } from "../db.js"
import { authMiddleware } from "../auth.js"

export const signalsRouter = new Hono()
signalsRouter.use("*", authMiddleware)

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
