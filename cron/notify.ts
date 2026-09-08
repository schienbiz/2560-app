import { clampMessage, LINE_TEXT_LIMIT, TELEGRAM_TEXT_LIMIT } from "../src/utils/message.js"

// Re-exported so existing importers (and tests) keep their entry point while
// the implementation lives in src/utils/message.ts, shared with the bot reply
// path in src/webhooks/telegram.ts.
export { clampMessage }

export async function pushLine(userId: string, message: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN not set")

  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text: clampMessage(message, LINE_TEXT_LIMIT) }],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LINE push failed: ${res.status} ${body}`)
  }
}

/**
 * Push a plain-text message to Telegram.
 *
 * NO `parse_mode`. Every notification body assembled by cron/scan.ts and
 * cron/morning-summary.ts contains free-form LLM text (`notifyInsight`,
 * `morningInsight`) and a user-chosen `label`, none of it escaped. Measured
 * against the live Bot API on 2026-09-07, `parse_mode: "HTML"` rejects a body
 * containing a bare `<`:
 *   400 Bad Request: can't parse entities: Unsupported start tag "50"
 * — before the chat is even resolved. An AI writing 「RSI<50 動能轉弱」 is
 * completely ordinary phrasing, and the resulting throw was swallowed by
 * runScan's Promise.allSettled: the cross notification vanished while the
 * workflow stayed green. These messages contain no markup, so plain text
 * loses nothing and cannot fail this way.
 */
export async function pushTelegram(chatId: string, message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set")

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: clampMessage(message, TELEGRAM_TEXT_LIMIT) }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Telegram push failed: ${res.status} ${body}`)
  }
}
