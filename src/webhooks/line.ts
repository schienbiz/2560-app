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
import { chatWithContext } from "../services/ai.js"
import { getUserContext } from "../services/bot-context.js"

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

async function sendWelcomeMessage(replyToken: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) return

  const liffId  = process.env.LIFF_ID
  const appUrl  = liffId ? `https://miniapp.line.me/${liffId}` : (process.env.APP_URL ?? "https://two560-app.onrender.com")

  await fetch("https://api.line.me/v2/bot/message/reply", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [
        {
          type: "text",
          text: "👋 歡迎使用 2560戰法助理！\n\n我會根據您的自選清單和交易記錄回答問題。\n\n可以問我：\n• BTCUSDT 現在有訊號嗎？\n• 我的自選清單有哪些？\n• 幫我分析 TSLA\n• 我最近的勝率如何？",
        },
        {
          type:    "template",
          altText: "開啟 2560戰法 App",
          template: {
            type: "buttons",
            text: "點下方開啟完整 App",
            actions: [
              { type: "uri", label: "📊 開啟 2560戰法 App", uri: appUrl },
            ],
          },
        },
      ],
    }),
  })
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
    if (event.type === "follow") {
      await sendWelcomeMessage(event.replyToken)
      return
    }

    if (event.type !== "message") return
    if (event.message?.type !== "text") return

    const userId = event.source.userId
    if (!userId) return

    const text = (event.message as LineTextMessage).text.trim()
    if (!text) return

    try {
      const ctx      = await getUserContext(userId, "line")
      const response = await chatWithContext(text, ctx)
      await replyMessage(event.replyToken, response)
    } catch (err) {
      console.error("[line-webhook] error:", err)
      await replyMessage(event.replyToken, "分析時發生錯誤，請稍後再試。")
    }
  }))

  return c.json({ ok: true })
}
