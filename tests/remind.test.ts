/**
 * runRemind — late delivery, and abandoning what is too late to be useful.
 *
 * The cron queried only reminders due TODAY, so one day it did not run, or one
 * failed push, left the row `sent = false` forever: never retried, never
 * expired, and still listed as pending by the app. Four such rows were sitting
 * in production from April 2026 (due 04-10, 04-15 and two on 04-28) — while
 * reminders on 04-21 and 04-22 had sent fine, so the cron itself worked.
 *
 * The load-bearing rule here is that `sent` keeps meaning "the user received
 * this". Clearing a stuck row by setting `sent = true` would make an
 * undelivered reminder indistinguishable from a delivered one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const findMany = vi.fn()
const update = vi.fn()
const updateMany = vi.fn()
const deliverMock = vi.fn()

vi.mock("../src/db.js", () => ({
  db: { remindMe: {
    findMany:   (...a: unknown[]) => findMany(...a),
    update:     (...a: unknown[]) => update(...a),
    updateMany: (...a: unknown[]) => updateMany(...a),
  } },
}))
vi.mock("../cron/notify.js", () => ({
  deliver: (...a: unknown[]) => deliverMock(...a),
  maskRecipient: (s: string) => s,
}))

import { runRemind } from "../cron/remind.js"

// 2026-09-09 12:00 UTC — 20:00 in Taipei, so the Taipei date is the 9th.
const NOW = Date.parse("2026-09-09T12:00:00Z")
const d = (s: string) => new Date(`${s}T00:00:00.000Z`)

const reminder = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "r1", user_id: "6308157099", platform: "telegram",
  symbol: "MPC", asset_type: "stock", note: null,
  remind_date: d("2026-09-09"), sent: false, expired_at: null,
  ...over,
})

describe("runRemind", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    update.mockResolvedValue(undefined)
    updateMany.mockResolvedValue({ count: 0 })
    deliverMock.mockResolvedValue("sent")
  })

  it("sends today's reminder and marks it sent", async () => {
    findMany.mockResolvedValue([reminder()])
    const r = await runRemind()
    expect(r).toMatchObject({ due: 1, sent: 1, failed: 0, expired: 0 })
    expect(update.mock.calls[0][0].data).toEqual({ sent: true })
  })

  it("still delivers one missed by a day or two — late beats never", async () => {
    findMany.mockResolvedValue([reminder({ remind_date: d("2026-09-07") })])
    const r = await runRemind()
    expect(r.sent).toBe(1)
    // and says so, rather than looking like it was scheduled for today
    expect(deliverMock.mock.calls[0][2]).toContain("原訂 2026-09-07")
  })

  it("does not label a same-day reminder as late", async () => {
    findMany.mockResolvedValue([reminder()])
    await runRemind()
    expect(deliverMock.mock.calls[0][2]).not.toContain("原訂")
  })

  it("expires one past the grace window instead of sending five-month-old noise", async () => {
    findMany.mockResolvedValue([reminder({ remind_date: d("2026-04-28") })])
    updateMany.mockResolvedValue({ count: 1 })

    const r = await runRemind()

    expect(deliverMock).not.toHaveBeenCalled()
    expect(r).toMatchObject({ due: 0, sent: 0, expired: 1 })
    // Expired, NOT "sent" — the record must not claim a delivery that never happened.
    expect(updateMany.mock.calls[0][0].data).toHaveProperty("expired_at")
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty("sent")
  })

  it("never reports an undelivered reminder as sent, even for a dead recipient", async () => {
    deliverMock.mockResolvedValue("deactivated")
    findMany.mockResolvedValue([reminder({ user_id: "dev-user", platform: "line" })])

    const r = await runRemind()

    expect(r.sent).toBe(0)
    expect(r.expired).toBe(1)
    expect(r.deactivated).toEqual(["line:dev-user"])
    expect(update.mock.calls[0][0].data).toHaveProperty("expired_at")
    expect(update.mock.calls[0][0].data).not.toHaveProperty("sent")
  })

  it("asks the database only for rows that are still outstanding", async () => {
    findMany.mockResolvedValue([])
    await runRemind()
    const where = findMany.mock.calls[0][0].where
    expect(where.sent).toBe(false)
    expect(where.expired_at).toBeNull()          // an abandoned row is never re-read
    expect(where.remind_date).not.toHaveProperty("gte")   // no longer "today only"
  })

  it("a bucket-filtered run cannot expire another market's reminder", async () => {
    // remind.yml handles tw+crypto and remind-us.yml handles us at a different
    // hour; a tw run must not abandon a US reminder before its own cron has had
    // a turn at it.
    findMany.mockResolvedValue([
      reminder({ id: "us-old", symbol: "MPC",      asset_type: "stock", remind_date: d("2026-04-28") }),
      reminder({ id: "tw-old", symbol: "8937.TWO", asset_type: "stock", remind_date: d("2026-04-28") }),
    ])
    updateMany.mockResolvedValue({ count: 1 })

    const r = await runRemind(["tw", "crypto"])

    expect(r.expired).toBe(1)
    expect(updateMany.mock.calls[0][0].where.id.in).toEqual(["tw-old"])
  })
})
