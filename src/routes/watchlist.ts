import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { db } from "../db.js"
import { authMiddleware } from "../auth.js"
import { getAdapter } from "../adapters/index.js"

export const watchlistRouter = new Hono()
watchlistRouter.use("*", authMiddleware)

// GET /api/watchlist
watchlistRouter.get("/", async c => {
  const { userId, platform } = c.get("user")
  const items = await db.watchlist.findMany({
    where: { user_id: userId, platform },
    include: { alert: true },
    orderBy: { created_at: "asc" },
  })

  // Attach most recent SignalHistory entry for each symbol (for badge display)
  const symbols = [...new Set(items.map(i => i.symbol))]
  const signals = await db.signalHistory.findMany({
    where: { symbol: { in: symbols } },
    orderBy: { signal_date: "desc" },
  })
  // One latest signal per symbol
  const latestBySymbol = new Map<string, typeof signals[0]>()
  for (const sig of signals) {
    if (!latestBySymbol.has(sig.symbol)) latestBySymbol.set(sig.symbol, sig)
  }

  const result = items.map(item => ({
    ...item,
    lastSignal: latestBySymbol.get(item.symbol) ?? null,
  }))

  return c.json(result)
})

// POST /api/watchlist
const addSchema = z.object({
  symbol: z.string().min(1).max(20),
  label:  z.string().max(50).optional(),
})

watchlistRouter.post("/", zValidator("json", addSchema), async c => {
  const { userId, platform } = c.get("user")
  const { symbol, label } = c.req.valid("json")

  const { adapter, normalizedSymbol } = getAdapter(symbol)
  const valid = await adapter.validateSymbol(normalizedSymbol)
  if (!valid) return c.json({ error: `Symbol not found: ${normalizedSymbol}` }, 422)

  const existing = await db.watchlist.findFirst({
    where: { user_id: userId, platform, symbol: normalizedSymbol },
  })
  if (existing) return c.json({ error: "Already in watchlist" }, 409)

  const item = await db.watchlist.create({
    data: {
      user_id:    userId,
      platform,
      symbol:     normalizedSymbol,
      asset_type: adapter.getAssetType(),
      label,
      alert: { create: { on_golden: true, on_death: true, active: true } },
    },
    include: { alert: true },
  })
  return c.json(item, 201)
})

// DELETE /api/watchlist/:id
watchlistRouter.delete("/:id", async c => {
  const { userId, platform } = c.get("user")
  const id = c.req.param("id")
  const item = await db.watchlist.findFirst({ where: { id, user_id: userId, platform } })
  if (!item) return c.json({ error: "Not found" }, 404)
  await db.watchlist.delete({ where: { id } })
  return c.json({ ok: true })
})

// PUT /api/watchlist/:id  (update label)
const updateSchema = z.object({
  label: z.string().max(50).nullable(),
})

watchlistRouter.put("/:id", zValidator("json", updateSchema), async c => {
  const { userId, platform } = c.get("user")
  const id = c.req.param("id")
  const { label } = c.req.valid("json")

  const item = await db.watchlist.findFirst({ where: { id, user_id: userId, platform } })
  if (!item) return c.json({ error: "Not found" }, 404)

  const updated = await db.watchlist.update({
    where: { id },
    data: { label: label ?? null },
    include: { alert: true },
  })
  return c.json(updated)
})

// PUT /api/watchlist/:id/alert
const alertSchema = z.object({
  on_golden: z.boolean().optional(),
  on_death:  z.boolean().optional(),
  active:    z.boolean().optional(),
})

watchlistRouter.put("/:id/alert", zValidator("json", alertSchema), async c => {
  const { userId, platform } = c.get("user")
  const id = c.req.param("id")
  const body = c.req.valid("json")

  const item = await db.watchlist.findFirst({ where: { id, user_id: userId, platform } })
  if (!item) return c.json({ error: "Not found" }, 404)

  const alert = await db.watchlistAlert.upsert({
    where: { watchlist_id: id },
    create: { watchlist_id: id, ...body },
    update: body,
  })
  return c.json(alert)
})
