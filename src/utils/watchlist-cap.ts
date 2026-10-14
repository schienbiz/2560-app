/**
 * Per-user watchlist cap.
 *
 * Anyone on Telegram can message the bot and `/追蹤` any symbol, and any LINE
 * or Telegram identity can POST /api/watchlist. Every watched symbol is fetched
 * and scored in the next daily scan, and that scan is ONE request with a hard
 * ceiling (Cloudflare cuts it near 100–125s; curl at 240s). A single account
 * adding a few hundred symbols would push the whole scan past that ceiling and
 * every user would lose that day's crosses — the same way 2330.TW's 09-04 death
 * cross was lost to one timed-out scan.
 *
 * Counted in the database, not in memory, so a restart (the free tier sleeps
 * after 15 idle minutes) does not reset it. Largest real list on 2026-10-14:
 * 13 symbols, so 30 leaves room to grow without a support request.
 */

import { db } from "../db.js"
import type { Platform } from "@prisma/client"

export const MAX_WATCHLIST_PER_USER = 30

export async function watchlistIsFull(userId: string, platform: Platform): Promise<boolean> {
  const n = await db.watchlist.count({ where: { user_id: userId, platform } })
  return n >= MAX_WATCHLIST_PER_USER
}
