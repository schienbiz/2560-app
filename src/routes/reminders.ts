import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { db } from "../db.js"
import { authMiddleware } from "../auth.js"
import { getAdapter } from "../adapters/index.js"
import { resolveSymbol } from "../utils/symbol.js"

export const remindersRouter = new Hono()
remindersRouter.use("*", authMiddleware)

// GET /api/reminders — still outstanding: not yet delivered, not abandoned.
//
// `expired_at` has to be excluded or the list keeps showing reminders that will
// never fire. Four rows from April 2026 sat here as "pending" for five months
// because the cron only ever looked at reminders due TODAY, so a missed day was
// permanent and invisible.
remindersRouter.get("/", async c => {
  const { userId, platform } = c.get("user")
  const items = await db.remindMe.findMany({
    where: {
      user_id:    userId,
      platform,
      sent:       false,
      expired_at: null,
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

  const { adapter } = getAdapter(symbol)
  const valid = await adapter.validateSymbol(symbol.toUpperCase().trim())
  if (!valid) return c.json({ error: `Symbol not found: ${symbol}` }, 422)

  // Same canonical form as the watchlist, so a reminder and its symbol's
  // signal history/cache all key on one string.
  const { symbol: normalizedSymbol, assetType, resolved } = await resolveSymbol(symbol)
  if (!resolved) {
    return c.json({ error: `無法確認 ${symbol} 的上市/上櫃別，請稍後再試` }, 422)
  }

  const item = await db.remindMe.create({
    data: {
      user_id:     userId,
      platform,
      symbol:      normalizedSymbol,
      asset_type:  assetType,
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
