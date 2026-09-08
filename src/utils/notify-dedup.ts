/**
 * Per-user notification idempotency.
 *
 * The scan used to dedup by asking SignalHistory "has this (symbol, date,
 * signal) been recorded?" — a GLOBAL question standing in for a per-user one.
 * With one user it looks identical; with two it means the first alert processed
 * writes the row and everyone else is skipped. Production has BTCUSDT watched
 * by two distinct users on LINE and two on Telegram, so the only thing keeping
 * all four notified is that every alert runs concurrently and reads before the
 * first write. Nothing enforces that: connection-pool queueing, a future
 * batching change, or a partial re-run flips it to "one person is told, the
 * rest silently are not", with no error anywhere.
 *
 * Claim-then-send, not check-then-send. `claimNotification` INSERTs the
 * idempotency key and lets the unique constraint arbitrate, so two concurrent
 * senders cannot both win. If the send then fails the claim is released, so a
 * re-run of the same scan can retry it rather than the alert being lost to a
 * transient push error.
 */

import { db } from "../db.js"
import type { Platform, SignalType } from "@prisma/client"

export interface NotificationKey {
  userId:     string
  platform:   Platform
  symbol:     string
  signalDate: Date
  signal:     SignalType
}

/** Postgres unique-violation, surfaced by Prisma as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002"
}

/**
 * Reserve the right to send this notification.
 * Returns false when someone (or an earlier run) already holds it.
 */
export async function claimNotification(key: NotificationKey): Promise<boolean> {
  try {
    await db.signalNotification.create({
      data: {
        user_id:     key.userId,
        platform:    key.platform,
        symbol:      key.symbol,
        signal:      key.signal,
        signal_date: key.signalDate,
      },
    })
    return true
  } catch (err) {
    if (isUniqueViolation(err)) return false
    throw err
  }
}

/**
 * Give the claim back after a failed send, so the next run may retry.
 * Never throws: losing the release is far less bad than losing the scan.
 */
export async function releaseNotification(key: NotificationKey): Promise<void> {
  await db.signalNotification.deleteMany({
    where: {
      user_id:     key.userId,
      platform:    key.platform,
      symbol:      key.symbol,
      signal:      key.signal,
      signal_date: key.signalDate,
    },
  }).catch(err => console.error("  ⚠ could not release notification claim:", err))
}
