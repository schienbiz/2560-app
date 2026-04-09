import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { db } from "../db.js"
import { authMiddleware } from "../auth.js"
import { computeStats } from "../engine/stats.js"
import type { TradeLike, SignalType } from "../engine/stats.js"

export const tradesRouter = new Hono()
tradesRouter.use("*", authMiddleware)

// GET /api/trades
tradesRouter.get("/", async c => {
  const { userId, platform } = c.get("user")
  const trades = await db.tradeRecord.findMany({
    where: { user_id: userId, platform },
    include: { signal: true },
    orderBy: { entry_date: "desc" },
  })
  return c.json(trades)
})

// GET /api/trades/stats
tradesRouter.get("/stats", async c => {
  const { userId, platform } = c.get("user")
  const trades = await db.tradeRecord.findMany({
    where: { user_id: userId, platform },
    include: { signal: true },
  })

  const mapped: TradeLike[] = trades.map(t => ({
    entry_price:  t.entry_price,
    exit_price:   t.exit_price,
    signal_type:  (t.signal?.signal ?? null) as SignalType | null,
  }))

  return c.json(computeStats(mapped))
})

// POST /api/trades
const createSchema = z.object({
  symbol:       z.string().min(1).max(20),
  direction:    z.enum(["long", "short"]).default("long"),
  entry_date:   z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  entry_price:  z.number().positive(),
  exit_date:    z.string().optional().nullable(),
  exit_price:   z.number().positive().optional().nullable(),
  quantity:     z.number().positive().optional().nullable(),
  notes:        z.string().max(500).optional().nullable(),
  signal_id:    z.string().optional().nullable(),
  watchlist_id: z.string().optional().nullable(),
})

tradesRouter.post("/", zValidator("json", createSchema), async c => {
  const { userId, platform } = c.get("user")
  const body = c.req.valid("json")
  const { adapter, normalizedSymbol } = await import("../adapters/index.js").then(m => m.getAdapter(body.symbol))

  const trade = await db.tradeRecord.create({
    data: {
      user_id:      userId,
      platform,
      symbol:       normalizedSymbol,
      asset_type:   adapter.getAssetType(),
      direction:    body.direction,
      entry_date:   new Date(body.entry_date),
      entry_price:  body.entry_price,
      exit_date:    body.exit_date   ? new Date(body.exit_date) : null,
      exit_price:   body.exit_price  ?? null,
      quantity:     body.quantity    ?? null,
      notes:        body.notes       ?? null,
      signal_id:    body.signal_id   ?? null,
      watchlist_id: body.watchlist_id ?? null,
    },
  })
  return c.json(trade, 201)
})

// PUT /api/trades/:id  (update exit price / date)
const updateSchema = z.object({
  exit_date:  z.string().optional().nullable(),
  exit_price: z.number().positive().optional().nullable(),
  notes:      z.string().max(500).optional().nullable(),
})

tradesRouter.put("/:id", zValidator("json", updateSchema), async c => {
  const { userId, platform } = c.get("user")
  const id = c.req.param("id")
  const body = c.req.valid("json")

  const existing = await db.tradeRecord.findFirst({ where: { id, user_id: userId, platform } })
  if (!existing) return c.json({ error: "Not found" }, 404)

  const updated = await db.tradeRecord.update({
    where: { id },
    data: {
      exit_date:  body.exit_date  ? new Date(body.exit_date) : existing.exit_date,
      exit_price: body.exit_price ?? existing.exit_price,
      notes:      body.notes      ?? existing.notes,
    },
  })
  return c.json(updated)
})

// DELETE /api/trades/:id
tradesRouter.delete("/:id", async c => {
  const { userId, platform } = c.get("user")
  const id = c.req.param("id")
  const existing = await db.tradeRecord.findFirst({ where: { id, user_id: userId, platform } })
  if (!existing) return c.json({ error: "Not found" }, 404)
  await db.tradeRecord.delete({ where: { id } })
  return c.json({ ok: true })
})
