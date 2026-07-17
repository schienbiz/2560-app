/**
 * Hard platform caps — LINE text message 5000 chars, Telegram sendMessage 4096.
 * An over-limit push does NOT truncate server-side: the API returns 400 and the
 * WHOLE message is silently lost. Clamp with an ellipsis so a long digest
 * degrades to a cut-off message instead of nothing.
 */
export function clampMessage(message: string, limit: number): string {
  return message.length <= limit ? message : message.slice(0, limit - 1) + "…"
}

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
      messages: [{ type: "text", text: clampMessage(message, 5000) }],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`LINE push failed: ${res.status} ${body}`)
  }
}

export async function pushTelegram(chatId: string, message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set")

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: clampMessage(message, 4096), parse_mode: "HTML" }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Telegram push failed: ${res.status} ${body}`)
  }
}
