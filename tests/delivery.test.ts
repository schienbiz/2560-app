/**
 * Permanent vs transient delivery failure.
 *
 * The first morning digest after push failures became visible (v1.7.0) reported
 * failed=2 of 6. The live backend's own log named both:
 *
 *   6308157099 (telegram)  403 Forbidden: bot was blocked by the user
 *   dev-user   (line)      400 The property, 'to', in the request body is invalid
 *
 * Both permanent — so without this classification the digest would fail EVERY
 * day, and a dead-man alert that cries wolf daily is one that stops being read.
 *
 * The dangerous direction is the other one: calling a transient fault permanent
 * silently switches off a real user's alerts. These tests exist mostly to pin
 * the cases that must NOT be treated as permanent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const findMany = vi.fn()
const updateMany = vi.fn()
vi.mock("../src/db.js", () => ({
  db: {
    watchlist:      { findMany: (...a: unknown[]) => findMany(...a) },
    watchlistAlert: { updateMany: (...a: unknown[]) => updateMany(...a) },
  },
}))

import {
  PushError, isAddressable, isPermanentDeliveryFailure, maskRecipient, deactivateRecipient,
} from "../src/utils/delivery.js"

describe("isAddressable", () => {
  it("accepts a real LINE user id (U + 32 hex)", () => {
    expect(isAddressable("line", "U54c92d13eacc71c343aa031bf1fabf8f")).toBe(true)
  })

  it("rejects `dev-user` — the id the Bearer-dev backdoor hands out", () => {
    // It has held an active alert since 2026-04-11 and failed every push since.
    expect(isAddressable("line", "dev-user")).toBe(false)
  })

  it("rejects a Telegram numeric id used as a LINE id, and vice versa", () => {
    expect(isAddressable("line", "6308157099")).toBe(false)
    expect(isAddressable("telegram", "U54c92d13eacc71c343aa031bf1fabf8f")).toBe(false)
  })

  it("accepts Telegram ids, including the negative ones groups use", () => {
    expect(isAddressable("telegram", "6308157099")).toBe(true)
    expect(isAddressable("telegram", "-1001234567890")).toBe(true)
  })

  it("rejects an uppercase-hex or wrong-length LINE id rather than guessing", () => {
    expect(isAddressable("line", "U54C92D13EACC71C343AA031BF1FABF8F")).toBe(false)
    expect(isAddressable("line", "U54c92d13")).toBe(false)
  })
})

describe("isPermanentDeliveryFailure", () => {
  it("Telegram 403 is permanent — blocked, kicked, or a deleted account", () => {
    expect(isPermanentDeliveryFailure(
      new PushError("Telegram push failed: 403 bot was blocked by the user", "telegram", 403))).toBe(true)
  })

  // ── everything below MUST be transient ──────────────────────────────────
  it("Telegram 429 is transient — that is what a retry is for", () => {
    expect(isPermanentDeliveryFailure(new PushError("429", "telegram", 429))).toBe(false)
  })

  it("Telegram 5xx is transient", () => {
    expect(isPermanentDeliveryFailure(new PushError("502", "telegram", 502))).toBe(false)
  })

  it("LINE 401/403 is NOT permanent — it means OUR token is wrong", () => {
    // The catastrophic misclassification: a botched token rotation would
    // otherwise deactivate every LINE recipient in one run.
    expect(isPermanentDeliveryFailure(new PushError("401", "line", 401))).toBe(false)
    expect(isPermanentDeliveryFailure(new PushError("403", "line", 403))).toBe(false)
  })

  it("LINE 400 is NOT permanent — it is ambiguous between a bad recipient and a bad message", () => {
    // The recipient half is already covered by isAddressable, without guessing
    // from an error string.
    expect(isPermanentDeliveryFailure(
      new PushError("LINE push failed: 400 The property, 'to', …", "line", 400))).toBe(false)
  })

  it("a plain Error (network, timeout, anything unexpected) is transient", () => {
    expect(isPermanentDeliveryFailure(new Error("fetch failed"))).toBe(false)
    expect(isPermanentDeliveryFailure(undefined)).toBe(false)
  })
})

describe("maskRecipient", () => {
  it("keeps the ends so a log line is traceable without publishing the id", () => {
    expect(maskRecipient("6308157099")).toBe("6308…7099")
  })
  it("leaves a short label alone", () => {
    expect(maskRecipient("dev-user")).toBe("dev-user")
  })
})

describe("deactivateRecipient", () => {
  beforeEach(() => { vi.clearAllMocks() })

  it("switches off every active alert the recipient owns, and deletes nothing", async () => {
    findMany.mockResolvedValue([{ id: "w1" }, { id: "w2" }])
    updateMany.mockResolvedValue({ count: 2 })

    expect(await deactivateRecipient("6308157099", "telegram", "blocked")).toBe(2)

    const arg = updateMany.mock.calls[0][0]
    expect(arg.data).toEqual({ active: false })          // reversible, not a delete
    expect(arg.where.watchlist_id.in).toEqual(["w1", "w2"])
    expect(arg.where.active).toBe(true)                   // idempotent on re-run
  })

  it("scopes to the platform, so a shared id cannot switch off the wrong channel", async () => {
    findMany.mockResolvedValue([])
    expect(await deactivateRecipient("6308157099", "telegram", "blocked")).toBe(0)
    expect(findMany.mock.calls[0][0].where).toEqual({ user_id: "6308157099", platform: "telegram" })
    expect(updateMany).not.toHaveBeenCalled()             // no rows → no query
  })
})
