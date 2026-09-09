import { clampMessage, LINE_TEXT_LIMIT, TELEGRAM_TEXT_LIMIT } from "../src/utils/message.js"
import {
  PushError, isAddressable, isPermanentDeliveryFailure, deactivateRecipient, maskRecipient,
} from "../src/utils/delivery.js"
import type { Platform } from "@prisma/client"

// Re-exported so existing importers (and tests) keep their entry point while
// the implementation lives in src/utils/message.ts, shared with the bot reply
// path in src/webhooks/telegram.ts.
export { clampMessage }

export type DeliveryOutcome = "sent" | "deactivated"

/**
 * Send one notification, and deal with a recipient who can never receive again.
 *
 * The three crons all had the same shape — `try { push } catch { count++ }` —
 * which was right for a transient fault and wrong for a permanent one: a user
 * who blocked the bot would fail the run every single day, turning the dead-man
 * alert into noise (the first morning digest under v1.7.0's new reporting hit
 * exactly that, failed=2 of 6, and both were permanent).
 *
 * Returns "deactivated" when the recipient was switched off; THROWS on a
 * transient failure, which is what should still make a run go red.
 */
export async function deliver(
  platform: Platform,
  userId: string,
  message: string,
): Promise<DeliveryOutcome> {
  // Decided from the id's shape, before any request: `dev-user` — the identity
  // the `Bearer dev` backdoor hands out — is not a LINE user id at all, and
  // sending to it can only ever produce a 400.
  if (!isAddressable(platform, userId)) {
    await deactivateRecipient(userId, platform, `not a valid ${platform} recipient id`)
    return "deactivated"
  }

  try {
    if (platform === "line") await pushLine(userId, message)
    else await pushTelegram(userId, message)
    return "sent"
  } catch (err) {
    if (isPermanentDeliveryFailure(err)) {
      await deactivateRecipient(userId, platform, (err as PushError).message.slice(0, 120))
      return "deactivated"
    }
    throw err
  }
}

export { maskRecipient }

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
    // PushError carries the status, so classification never has to parse a
    // message. Note a LINE 401/403 means OUR token is wrong, not that the
    // recipient is gone — see src/utils/delivery.ts for why that distinction
    // has to survive.
    throw new PushError(`LINE push failed: ${res.status} ${body}`, "line", res.status)
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
    // 403 here means blocked / kicked / account deactivated — always about this
    // one chat, and the only status `isPermanentDeliveryFailure` acts on.
    throw new PushError(`Telegram push failed: ${res.status} ${body}`, "telegram", res.status)
  }
}
