/**
 * Telling a recipient who can NEVER receive again from one who is merely
 * unreachable right now.
 *
 * WHY THIS EXISTS. v1.7.0 made push failures visible for the first time, and
 * the very first morning digest under it reported failed=2 of 6. Reading the
 * live backend's own log identified both:
 *
 *   6308157099 (telegram)  403 Forbidden: bot was blocked by the user
 *   dev-user   (line)      400 The property, 'to', in the request body is invalid
 *
 * Both are permanent. Left alone they would fail the digest EVERY day — a
 * Telegram dead-man alert that cries wolf daily is one that stops being read,
 * which would quietly undo the whole point of making failures visible.
 *
 * `dev-user` is the identity `src/auth.ts` hands out for the `Bearer dev`
 * development backdoor. It has held an active BTCUSDT alert since 2026-04-11
 * and has been failing silently for five months — the app shares ONE Neon
 * database, so a local dev session writes straight into production data.
 *
 * SAFETY. Misclassifying a transient fault as permanent would silently switch
 * off a real user's alerts, so the rules here are deliberately narrow:
 *
 *   - An id that is not even addressable on its platform (`dev-user`) — decided
 *     BEFORE any request, from the id's shape alone, so it cannot depend on an
 *     error string.
 *   - Telegram HTTP 403 on sendMessage, which means blocked / kicked / account
 *     deactivated. Always about that one chat.
 *
 * Everything else is transient, and that is the important part of the design:
 *   - LINE 401/403 means OUR channel access token is wrong. Treating it as a
 *     recipient problem would deactivate every LINE user the moment a token
 *     rotation went wrong.
 *   - LINE 400 is ambiguous — it can be a bad recipient OR a malformed message
 *     — so it is never used as grounds for deactivation. The shape check above
 *     already covers the recipient half without guessing.
 *   - 429 / 5xx / timeouts are exactly what a retry is for.
 */

import { db } from "../db.js"
import type { Platform } from "@prisma/client"

/** Error carrying the HTTP status, so classification never parses a message. */
export class PushError extends Error {
  constructor(
    message: string,
    readonly platform: Platform,
    readonly status: number,
  ) {
    super(message)
    this.name = "PushError"
  }
}

/** LINE user id: "U" + 32 hex. Telegram chat id: digits (negative for groups). */
export function isAddressable(platform: Platform, userId: string): boolean {
  return platform === "line"
    ? /^U[0-9a-f]{32}$/.test(userId)
    : /^-?\d+$/.test(userId)
}

/**
 * Is this failure about the RECIPIENT, permanently?
 * Narrow on purpose — see the safety note above.
 */
export function isPermanentDeliveryFailure(err: unknown): boolean {
  return err instanceof PushError && err.platform === "telegram" && err.status === 403
}

/** Short, non-identifying label for logs and API responses. */
export function maskRecipient(userId: string): string {
  return userId.length <= 8 ? userId : `${userId.slice(0, 4)}…${userId.slice(-4)}`
}

/**
 * Switch off every alert for a recipient that can never be reached again.
 *
 * Reversible: it flips `active`, deletes nothing. The alternative — retrying a
 * blocked chat forever — costs a pointless API call per symbol per day and, far
 * worse, keeps the run red so the alert that is supposed to mean "the backend is
 * down" comes to mean nothing.
 */
export async function deactivateRecipient(
  userId: string,
  platform: Platform,
  reason: string,
): Promise<number> {
  const items = await db.watchlist.findMany({
    where: { user_id: userId, platform },
    select: { id: true },
  })
  if (items.length === 0) return 0

  const res = await db.watchlistAlert.updateMany({
    where: { watchlist_id: { in: items.map(i => i.id) }, active: true },
    data: { active: false },
  })
  if (res.count > 0) {
    console.warn(`  ⚠ deactivated ${res.count} alert(s) for ${platform}:${maskRecipient(userId)} — ${reason}`)
  }
  return res.count
}
