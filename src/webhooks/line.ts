/**
 * LINE bot webhook handler.
 *
 * Endpoint: POST /webhook/line
 *
 * Verifies X-Line-Signature (HMAC-SHA256 with LINE_CHANNEL_SECRET).
 * Handles text messages — looks up user's watchlist + recent trades,
 * then asks Claude for a response.
 *
 * Required env:
 *   LINE_CHANNEL_SECRET       — from LINE Developers console (for signature verify)
 *   LINE_CHANNEL_ACCESS_TOKEN — for sending reply messages
 *   GROQ_API_KEY
 */

import { createHmac } from "crypto"
import type { Context } from "hono"
import { db } from "../db.js"
import { chatWithContext } from "../services/ai.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface LineTextMessage { type: "text"; text: string }
interface LineEvent {
  type:       string
  replyToken: string
  source:     { type: string; userId?: string }
  message?:   LineTextMessage | { type: string }
}
interface LineWebhookBody { events: LineEvent[] }

// ─── Signature verification ───────────────────────────────────────────────────

function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET
  if (!secret) return false
  const expected = createHmac("sha256", secret).update(body).digest("base64")
  return expected === signature
}

// ─── Reply via LINE Messaging API ─────────────────────────────────────────────

async function replyMessage(replyToken: string, text: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  })
}

// ─── User context from DB ─────────────────────────────────────────────────────

async function getUserContext(userId: string) {
  const [watchlistItems, recentTrades] = await Promise.all([
    db.watchlist.findMany({
      where:   { user_id: userId, platform: "line" },
      select:  { symbol: true },
      orderBy: { created_at: "desc" },
      take:    10,
    }),
    db.tradeRecord.findMany({
      where:   { user_id: userId, platform: "line" },
      orderBy: { entry_date: "desc" },
      take:    5,
    }),
  ])

  return {
    watchlist:    watchlistItems.map((w: { symbol: string }) => ({ symbol: w.symbol })),
    recentTrades: recentTrades.map((t: { symbol: string; direction: string; entry_price: number; exit_price: number | null }) => ({
      symbol:      t.symbol,
      direction:   t.direction,
      entry_price: t.entry_price,
      exit_price:  t.exit_price,
    })),
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleLineWebhook(c: Context): Promise<Response> {
  const signature = c.req.header("X-Line-Signature") ?? ""
  const rawBody   = await c.req.text()

  if (!verifySignature(rawBody, signature)) {
    return c.json({ error: "Invalid signature" }, 401)
  }

  if (!process.env.GROQ_API_KEY) {
    return c.json({ ok: true })  // Acknowledge but skip AI
  }

  let body: LineWebhookBody
  try { body = JSON.parse(rawBody) } catch { return c.json({ ok: true }) }

  // Process events concurrently (fire-and-forget per LINE recommendation)
  await Promise.allSettled(body.events.map(async event => {
    if (event.type !== "message") return
    if (event.message?.type !== "text") return

    const userId = event.source.userId
    if (!userId) return

    const text = (event.message as LineTextMessage).text.trim()
    if (!text) return

    try {
      const ctx      = await getUserContext(userId)
      const response = await chatWithContext(text, ctx)
      await replyMessage(event.replyToken, response)
    } catch (err) {
      console.error("[line-webhook] error:", err)
      await replyMessage(event.replyToken, "分析時發生錯誤，請稍後再試。")
    }
  }))

  return c.json({ ok: true })
}
