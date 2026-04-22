/**
 * Telegram bot webhook handler.
 *
 * Endpoint: POST /webhook/telegram
 *
 * Verifies the X-Telegram-Bot-Api-Secret-Token header (set when registering
 * the webhook via setWebhook). Falls back to open if TELEGRAM_WEBHOOK_SECRET
 * is not configured (dev mode).
 *
 * Handles text messages — looks up user's watchlist + recent trades,
 * then asks Claude for a response.
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN         — for sending replies
 *   TELEGRAM_WEBHOOK_SECRET    — optional but recommended; set same value in setWebhook
 *   GROQ_API_KEY
 */

import type { Context } from "hono"
import { chatWithContext } from "../services/ai.js"
import { getUserContext } from "../services/bot-context.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface TgUser    { id: number; first_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number }; text?: string }
interface TgUpdate  { update_id: number; message?: TgMessage }

// ─── Send message via Bot API ─────────────────────────────────────────────────

async function sendMessage(chatId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  })
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleTelegramWebhook(c: Context): Promise<Response> {
  // Verify webhook secret if configured
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (webhookSecret) {
    const incoming = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? ""
    if (incoming !== webhookSecret) {
      return c.json({ error: "Invalid secret" }, 401)
    }
  }

  if (!process.env.GROQ_API_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ ok: true })
  }

  let update: TgUpdate
  try { update = await c.req.json<TgUpdate>() } catch { return c.json({ ok: true }) }

  const msg = update.message
  if (!msg?.text || !msg.from) return c.json({ ok: true })

  const text   = msg.text.trim()
  const chatId = msg.chat.id
  const userId = String(msg.from.id)

  // Handle /start command
  if (text === "/start") {
    await sendMessage(chatId,
      "👋 歡迎使用 2560戰法助理！\n\n你可以問我：\n• 2330 現在可以進場嗎？\n• 我的自選清單有哪些訊號？\n• 黃金交叉是什麼意思？\n\n直接傳訊息就行，不需要特殊指令。"
    )
    return c.json({ ok: true })
  }

  // Async — respond as quickly as possible to Telegram's 5s timeout
  setImmediate(async () => {
    try {
      const ctx      = await getUserContext(userId, "telegram")
      const response = await chatWithContext(text, ctx)
      await sendMessage(chatId, response)
    } catch (err) {
      console.error("[tg-webhook] error:", err)
      await sendMessage(chatId, "分析時發生錯誤，請稍後再試。")
    }
  })

  return c.json({ ok: true })
}
