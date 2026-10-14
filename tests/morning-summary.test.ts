/**
 * runMorningSummary must never call a broken read a quiet market.
 *
 * A symbol whose processing rejected was dropped by a `fulfilled`-only filter,
 * and a missing cached series returned null like a symbol with no cross. A user
 * whose every symbol failed therefore received 「今天自選股全部平靜」 — the
 * exact message a genuinely calm day produces, with the workflow green.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { OHLCV } from "../src/engine/types.js"

const findAlerts = vi.fn()
const cached     = vi.fn()
const why        = vi.fn()
const sent: { userId: string; msg: string }[] = []

vi.mock("../src/db.js", () => ({
  db: {
    watchlistAlert: { findMany: (...a: unknown[]) => findAlerts(...a) },
    signalHistory:  { findMany: async () => [] },
  },
}))
vi.mock("../src/cache.js", () => ({
  getCachedOHLCVByBarAge: (...a: unknown[]) => cached(...a),
  whyNoCachedSeries:      (...a: unknown[]) => why(...a),
  DIGEST_MAX_BAR_AGE_DAYS: 7,
}))
vi.mock("../src/services/ai.js", () => ({
  morningInsight:    async () => "insight",
  hasAnyProviderKey: () => true,
}))
vi.mock("../cron/notify.js", () => ({
  deliver: async (_p: string, userId: string, msg: string) => { sent.push({ userId, msg }); return "sent" },
  maskRecipient: (s: string) => s,
}))

import { runMorningSummary } from "../cron/morning-summary.js"

/** 80 flat bars: MAs equal, no cross anywhere — a genuinely quiet symbol. */
const quiet = (): OHLCV[] => Array.from({ length: 80 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
  open: 100, high: 100, low: 100, close: 100, volume: 1,
}))

const alertFor = (symbol: string) => ({
  fast_period: 25, slow_period: 60, active: true,
  watchlist: { user_id: "u1", platform: "telegram", symbol, asset_type: "stock", label: null },
})

const CALM = "今天自選股全部平靜"

describe("runMorningSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sent.length = 0
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  it("says calm only when every symbol was read and none has a cross", async () => {
    findAlerts.mockResolvedValue([alertFor("AAA"), alertFor("BBB")])
    cached.mockResolvedValue(quiet())

    const r = await runMorningSummary()

    expect(sent[0].msg).toContain(CALM)
    expect(r.unreadable).toBe(0)
  })

  it("a symbol whose read throws is reported, never folded into 'calm'", async () => {
    findAlerts.mockResolvedValue([alertFor("AAA"), alertFor("BBB")])
    cached.mockImplementation(async (s: string) => {
      if (s === "BBB") throw new Error("Can't reach database server")
      return quiet()
    })

    const r = await runMorningSummary()

    expect(sent[0].msg).not.toContain(CALM)
    expect(sent[0].msg).toContain("1 檔資料讀取失敗")
    expect(r.unreadable).toBe(1)
  })

  it("no recent cached bars at all counts as unreadable", async () => {
    findAlerts.mockResolvedValue([alertFor("AAA")])
    cached.mockResolvedValue(null)
    why.mockResolvedValue("stale-or-missing")

    const r = await runMorningSummary()

    expect(sent[0].msg).not.toContain(CALM)
    expect(r.unreadable).toBe(1)
  })

  it("a new listing with too little history is skipped, not a failure", async () => {
    // The scan treats this as insufficientData without failing; the digest
    // must not turn the workflow red every day for the listing's first months.
    findAlerts.mockResolvedValue([alertFor("NEWCO")])
    cached.mockResolvedValue(null)
    why.mockResolvedValue("thin-history")

    const r = await runMorningSummary()

    expect(sent[0].msg).toContain(CALM)
    expect(r.unreadable).toBe(0)
  })
})
