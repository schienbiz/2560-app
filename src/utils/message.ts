/**
 * Outbound message-shaping helpers, shared by the push (cron/notify.ts) and
 * reply (webhooks/*) paths so both obey the same platform limits.
 */

/** Hard platform caps for a single text message. */
export const LINE_TEXT_LIMIT     = 5000
export const TELEGRAM_TEXT_LIMIT = 4096

/**
 * Clamp to a platform's hard cap.
 *
 * An over-limit message does NOT truncate server-side: the API returns 400 and
 * the WHOLE message is silently lost. Clamping degrades a long digest to a
 * cut-off message instead of nothing.
 *
 * The slice is done on code POINTS, not UTF-16 code units: `String.slice` can
 * cut an emoji's surrogate pair in half, and a lone surrogate is invalid UTF-8
 * — which is itself a 400, i.e. the exact failure this function exists to
 * prevent. Both platforms count in UTF-16 units, so the cap is still measured
 * with `.length`.
 */
export function clampMessage(message: string, limit: number): string {
  if (message.length <= limit) return message
  const budget = limit - 1                     // room for the ellipsis
  let out = message.slice(0, budget)
  // Trim a trailing lone high surrogate (0xD800–0xDBFF) left by the cut.
  const lastCode = out.charCodeAt(out.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) out = out.slice(0, -1)
  return out + "…"
}
