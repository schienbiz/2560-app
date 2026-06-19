/**
 * Telegram bot webhook handler.
 *
 * Endpoint: POST /webhook/telegram
 *
 * Verifies the X-Telegram-Bot-Api-Secret-Token header (set when registering
 * the webhook via setWebhook). Falls back to open if TELEGRAM_WEBHOOK_SECRET
 * is not configured (dev mode).
 *
 * Commands:
 *   /start            — welcome message
 *   /pulse            — signal radar mini app
 *   /追蹤 <symbol>    — add symbol to watchlist (notifications on)
 *   /移除 <symbol>    — remove symbol from watchlist
 *   /清單             — list current watchlist
 *
 * AI fallback — any other text goes to chatWithContext.
 *
 * Required env:
 *   TELEGRAM_BOT_TOKEN         — for sending replies
 *   TELEGRAM_WEBHOOK_SECRET    — optional but recommended; set same value in setWebhook
 *   GROQ_API_KEY
 */

import type { Context }   from "hono"
import type { AssetType } from "../engine/types.js"
import { db }              from "../db.js"
import { getAdapter }      from "../adapters/index.js"
import { chatWithContext } from "../services/ai.js"
import { getUserContext }  from "../services/bot-context.js"

// ─── Types ────────────────────────────────────────────────────────────────────

interface TgUser    { id: number; first_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number }; text?: string }
interface TgUpdate  { update_id: number; message?: TgMessage }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const APP_URL   = process.env.APP_URL ?? "https://two560-app.onrender.com"
const PULSE_URL = `${APP_URL}/pulse`

async function sendMessage(chatId: number, text: string, replyMarkup?: object) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  "POST",
    signal:  AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      chat_id:      chatId,
      text,
      parse_mode:   "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  })
}

// ─── Watchlist commands ───────────────────────────────────────────────────────

async function handleWatch(chatId: number, rawSymbol: string) {
  if (!rawSymbol) {
    await sendMessage(chatId, "請輸入標的代碼，例如：/追蹤 2330 或 /追蹤 BTCUSDT")
    return
  }

  let normalizedSymbol: string
  let assetType: AssetType
  try {
    const result = getAdapter(rawSymbol)
    normalizedSymbol = result.normalizedSymbol
    assetType        = result.adapter.getAssetType()

    const valid = await result.adapter.validateSymbol(normalizedSymbol)
    if (!valid) {
      await sendMessage(chatId, `找不到標的「${rawSymbol}」，請確認代碼是否正確。`)
      return
    }
  } catch {
    await sendMessage(chatId, `找不到標的「${rawSymbol}」，請確認代碼是否正確。`)
    return
  }

  const userId = String(chatId)

  const existing = await db.watchlist.findFirst({
    where: { user_id: userId, platform: "telegram", symbol: normalizedSymbol },
  })
  if (existing) {
    await sendMessage(chatId, `「${normalizedSymbol}」已在你的自選清單中。`)
    return
  }

  await db.watchlist.create({
    data: {
      user_id:    userId,
      platform:   "telegram",
      symbol:     normalizedSymbol,
      asset_type: assetType,
      alert: { create: { on_golden: true, on_death: true, active: true } },
    },
  })

  await sendMessage(chatId,
    `✅ 已加入追蹤：<b>${normalizedSymbol}</b>\n\n黃金交叉、死亡交叉、接近進場區時會主動通知你。`
  )
}

async function handleUnwatch(chatId: number, rawSymbol: string) {
  if (!rawSymbol) {
    await sendMessage(chatId, "請輸入標的代碼，例如：/移除 2330")
    return
  }

  const userId = String(chatId)
  const sym    = rawSymbol.toUpperCase().trim()

  const item = await db.watchlist.findFirst({
    where: { user_id: userId, platform: "telegram", symbol: sym },
  })
  if (!item) {
    await sendMessage(chatId, `「${sym}」不在你的自選清單中。`)
    return
  }

  await db.watchlist.delete({ where: { id: item.id } })
  await sendMessage(chatId, `🗑 已移除追蹤：<b>${sym}</b>`)
}

async function handleList(chatId: number) {
  const userId = String(chatId)
  const items  = await db.watchlist.findMany({
    where:   { user_id: userId, platform: "telegram" },
    include: { alert: true },
    orderBy: { created_at: "asc" },
  })

  if (items.length === 0) {
    await sendMessage(chatId,
      "你的自選清單是空的。\n\n用 /追蹤 &lt;代碼&gt; 加入標的，例如：\n/追蹤 2330\n/追蹤 BTCUSDT"
    )
    return
  }

  const lines = items.map(item => {
    const alert  = item.alert
    const status = alert?.active ? "🔔" : "🔕"
    return `${status} <b>${item.symbol}</b>${item.label ? ` (${item.label})` : ""}`
  })

  await sendMessage(chatId,
    `📋 你的自選清單（共 ${items.length} 項）：\n\n${lines.join("\n")}\n\n黃金交叉或接近進場區時會自動通知。`
  )
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleTelegramWebhook(c: Context): Promise<Response> {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (webhookSecret) {
    const incoming = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? ""
    if (incoming !== webhookSecret) {
      return c.json({ error: "Invalid secret" }, 401)
    }
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return c.json({ ok: true })
  }

  let update: TgUpdate
  try { update = await c.req.json<TgUpdate>() } catch { return c.json({ ok: true }) }

  const msg = update.message
  if (!msg?.text || !msg.from) return c.json({ ok: true })

  const text   = msg.text.trim()
  const chatId = msg.chat.id
  const userId = String(chatId)  // use chatId for both lookup and push

  // ── /start ──────────────────────────────────────────────────────────────────
  if (text === "/start") {
    await sendMessage(
      chatId,
      "👋 歡迎使用 <b>2560 戰法助理</b>！\n\n追蹤 MA 均線交叉訊號，黃金交叉、死亡交叉、接近進場區時自動通知你。\n\n📊 <b>指令</b>\n/追蹤 &lt;代碼&gt; — 加入自選，收即時通知\n/移除 &lt;代碼&gt; — 移除自選\n/清單 — 查看目前追蹤清單\n\n💬 也可以直接問我問題：\n• 2330 現在可以進場嗎？\n• BTCUSDT 趨勢怎麼看？",
      {
        inline_keyboard: [
          [{ text: "📈 開啟 2560 App", web_app: { url: APP_URL } }],
          [{ text: "📡 信號雷達（公開）", web_app: { url: PULSE_URL } }],
        ],
      }
    )
    return c.json({ ok: true })
  }

  // ── /pulse ──────────────────────────────────────────────────────────────────
  if (text === "/pulse") {
    await sendMessage(
      chatId,
      "📡 2560信號雷達\n\n追蹤 MA25/MA60 黃金交叉熱門標的：",
      {
        inline_keyboard: [[
          { text: "開啟信號雷達", web_app: { url: PULSE_URL } },
        ]],
      }
    )
    return c.json({ ok: true })
  }

  // ── /追蹤 <symbol> ──────────────────────────────────────────────────────────
  if (text.startsWith("/追蹤") || text.startsWith("/watch")) {
    const symbol = text.replace(/^\/追蹤|^\/watch/, "").trim()
    await handleWatch(chatId, symbol)
    return c.json({ ok: true })
  }

  // ── /移除 <symbol> ──────────────────────────────────────────────────────────
  if (text.startsWith("/移除") || text.startsWith("/unwatch")) {
    const symbol = text.replace(/^\/移除|^\/unwatch/, "").trim()
    await handleUnwatch(chatId, symbol)
    return c.json({ ok: true })
  }

  // ── /清單 ───────────────────────────────────────────────────────────────────
  if (text === "/清單" || text === "/list") {
    await handleList(chatId)
    return c.json({ ok: true })
  }

  // ── AI fallback ─────────────────────────────────────────────────────────────
  if (!process.env.GROQ_API_KEY && !process.env.NVIDIA_API_KEY) return c.json({ ok: true })

  // Async — respond before Telegram's 5s timeout
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
