import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { db } from "../db.js"
import { authMiddleware } from "../auth.js"
import { getAdapter } from "../adapters/index.js"

export const remindersRouter = new Hono()
remindersRouter.use("*", authMiddleware)

// GET /api/reminders  (upcoming only)
remindersRouter.get("/", async c => {
  const { userId, platform } = c.get("user")
  const items = await db.remindMe.findMany({
    where: {
      user_id:  userId,
      platform,
      sent:     false,
      remind_date: { gte: new Date() },
    },
    orderBy: { remind_date: "asc" },
  })
  return c.json(items)
})

// POST /api/reminders
const createSchema = z.object({
  symbol:      z.string().min(1).max(20),
  remind_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format: YYYY-MM-DD"),
  note:        z.string().max(200).optional().nullable(),
})

remindersRouter.post("/", zValidator("json", createSchema), async c => {
  const { userId, platform } = c.get("user")
  const { symbol, remind_date, note } = c.req.valid("json")

  const { adapter, normalizedSymbol } = getAdapter(symbol)

  const item = await db.remindMe.create({
    data: {
      user_id:     userId,
      platform,
      symbol:      normalizedSymbol,
      asset_type:  adapter.getAssetType(),
      remind_date: new Date(remind_date),
      note:        note ?? null,
    },
  })
  return c.json(item, 201)
})

// DELETE /api/reminders/:id
remindersRouter.delete("/:id", async c => {
  const { userId, platform } = c.get("user")
  const id = c.req.param("id")
  const item = await db.remindMe.findFirst({ where: { id, user_id: userId, platform } })
  if (!item) return c.json({ error: "Not found" }, 404)
  await db.remindMe.delete({ where: { id } })
  return c.json({ ok: true })
})
