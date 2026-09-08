/**
 * runScan behaviour — the file where the notification bugs actually lived and
 * which had no test of its own (scan-alert.test.ts only covers the two pure
 * string helpers).
 *
 * Two production facts drive these cases:
 *   - BTCUSDT is watched by two DISTINCT users on LINE and two more on
 *     Telegram, so a dedup keyed on the global SignalHistory row silently
 *     notifies one of them and drops the rest.
 *   - A symbol whose bars cannot be fetched is not merely late: the cron uses
 *     lookback=1, so by tomorrow the cross is no longer the last bar and it is
 *     never detected — while the run reported success.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const findAlerts    = vi.fn()
const historyUpsert = vi.fn()
const historyFirst  = vi.fn()
const pushLine      = vi.fn()
const pushTelegram  = vi.fn()
const adapterFetch  = vi.fn()
const claim         = vi.fn()
const release       = vi.fn()

vi.mock("../src/db.js", () => ({
  db: {
    watchlistAlert: { findMany: (...a: unknown[]) => findAlerts(...a) },
    signalHistory:  {
      upsert:    (...a: unknown[]) => historyUpsert(...a),
      findFirst: (...a: unknown[]) => historyFirst(...a),
    },
  },
}))
vi.mock("../src/utils/ohlcv.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/utils/ohlcv.js")>()
  return { ...actual, getOrFetchOHLCV: (...a: unknown[]) => adapterFetch(...a) }
})
vi.mock("../src/utils/notify-dedup.js", () => ({
  claimNotification:   (...a: unknown[]) => claim(...a),
  releaseNotification: (...a: unknown[]) => release(...a),
}))
vi.mock("../cron/notify.js", () => ({
  pushLine:     (...a: unknown[]) => pushLine(...a),
  pushTelegram: (...a: unknown[]) => pushTelegram(...a),
}))
vi.mock("../src/services/ai.js", () => ({ notifyInsight: async () => "" }))
vi.mock("../src/services/news.js", () => ({
  fetchFearGreed: async () => null,
  scoreFearGreed: () => ({ score: 0, summary: "" }),
}))
vi.mock("../src/utils/strong-death.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/utils/strong-death.js")>()
  return { ...actual, evaluateStrongDeath: async () => null }
})

import { runScan } from "../cron/scan.js"
import type { OHLCV } from "../src/engine/types.js"

/**
 * 80 bars that produce a golden cross on the LAST bar under MA5/MA10.
 *
 * Constructed so the claim is checkable by hand rather than by eyeballing a
 * chart: hold flat at V, then spike the final bar to S.
 *   previous bar: MA5 = MA10 = V                     → p_fast <= p_slow ✓
 *   final bar:    MA5 = (4V+S)/5, MA10 = (9V+S)/10
 *                 MA5 − MA10 = (S − V)/10 > 0        → c_fast >  c_slow ✓
 * With V=100, S=130: MA5 = 106, MA10 = 103. The cron scans with lookback=1, so
 * the cross must land on the very last bar or nothing fires at all — the first
 * version of this fixture rallied over ten bars and crossed several bars early,
 * which every assertion below would then have "passed" against zero sends.
 */
function crossingSeries(): OHLCV[] {
  const closes = Array(79).fill(100).concat([130])
  return closes.map((c, i) => ({
    date:   new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
    open: c, high: c, low: c, close: c, volume: 1_000_000,
  }))
}

const alertFor = (user: string, platform: "line" | "telegram", symbol = "BTCUSDT") => ({
  fast_period: 5, slow_period: 10, on_golden: true, on_death: true,
  proximity_threshold: 0.015, active: true,
  watchlist: { user_id: user, platform, symbol, asset_type: "crypto", label: null },
})

/**
 * A real in-memory stand-in for the SignalNotification unique constraint.
 *
 * `claim.mockResolvedValue(true)` would make the multi-user assertions
 * tautological — they would pass even if the scan claimed a key with no user
 * in it, which is exactly the bug. This ledger enforces the constraint, so a
 * key missing `userId`/`platform` collapses four sends into one and the test
 * fails, as it should.
 */
const keyOf = (k: { userId: string; platform: string; symbol: string; signalDate: Date; signal: string }) =>
  `${k.userId}|${k.platform}|${k.symbol}|${k.signalDate.toISOString()}|${k.signal}`

describe("runScan", () => {
  let ledger: Set<string>

  beforeEach(() => {
    vi.clearAllMocks()
    ledger = new Set()
    historyUpsert.mockResolvedValue(undefined)
    historyFirst.mockResolvedValue(null)
    pushLine.mockResolvedValue(undefined)
    pushTelegram.mockResolvedValue(undefined)
    claim.mockImplementation(async (k: Parameters<typeof keyOf>[0]) => {
      const id = keyOf(k)
      if (ledger.has(id)) return false
      ledger.add(id)
      return true
    })
    release.mockImplementation(async (k: Parameters<typeof keyOf>[0]) => { ledger.delete(keyOf(k)) })
    adapterFetch.mockResolvedValue(crossingSeries())
  })

  it("detects the cross on the last bar (fixture sanity — otherwise these tests prove nothing)", async () => {
    findAlerts.mockResolvedValue([alertFor("u1", "telegram")])
    const r = await runScan()
    expect(r.notified).toBe(1)
    expect(historyUpsert).toHaveBeenCalled()
  })

  it("notifies EVERY user watching the symbol, not just the first one processed", async () => {
    findAlerts.mockResolvedValue([
      alertFor("line-a", "line"),
      alertFor("line-b", "line"),
      alertFor("tg-a", "telegram"),
      alertFor("tg-b", "telegram"),
    ])

    const r = await runScan()

    expect(r.notified).toBe(4)
    expect(pushLine.mock.calls.map(c => c[0]).sort()).toEqual(["line-a", "line-b"])
    expect(pushTelegram.mock.calls.map(c => c[0]).sort()).toEqual(["tg-a", "tg-b"])
  })

  it("claims per (user, platform), so the ledger can tell the four sends apart", async () => {
    findAlerts.mockResolvedValue([alertFor("u1", "line"), alertFor("u1", "telegram")])
    await runScan()
    const claimed = claim.mock.calls.map(c => `${c[0].userId}/${c[0].platform}/${c[0].signal}`)
    expect(claimed).toContain("u1/line/golden_cross")
    expect(claimed).toContain("u1/telegram/golden_cross")
  })

  it("does not send when the claim is already held (an earlier run alerted this user)", async () => {
    claim.mockResolvedValue(false)
    findAlerts.mockResolvedValue([alertFor("u1", "telegram")])
    const r = await runScan()
    expect(r.notified).toBe(0)
    expect(pushTelegram).not.toHaveBeenCalled()
  })

  it("releases the claim when the push fails, so a re-run can retry", async () => {
    pushTelegram.mockRejectedValue(new Error("Telegram push failed: 400"))
    findAlerts.mockResolvedValue([alertFor("u1", "telegram")])

    const r = await runScan()

    expect(release).toHaveBeenCalledTimes(1)
    expect(release.mock.calls[0][0]).toMatchObject({ userId: "u1", signal: "golden_cross" })
    expect(r.alertFailed).toBe(1)
    expect(r.notified).toBe(0)
    // The key is back in the pool — a re-run is not permanently blocked.
    expect(ledger.size).toBe(0)

    pushTelegram.mockResolvedValue(undefined)
    expect((await runScan()).notified).toBe(1)
  })

  it("reports a symbol whose bars could not be fetched instead of warning into the void", async () => {
    adapterFetch.mockRejectedValue(new Error("Yahoo fetch failed: 429 2330.TW"))
    findAlerts.mockResolvedValue([alertFor("u1", "telegram", "2330.TW")])

    const r = await runScan()

    expect(r.fetchFailed).toEqual(["2330.TW"])
    expect(r.notified).toBe(0)
  })

  it("treats an empty bar array as a fetch failure, not as a quiet market", async () => {
    adapterFetch.mockResolvedValue([])
    findAlerts.mockResolvedValue([alertFor("u1", "telegram", "2330.TW")])
    const r = await runScan()
    expect(r.fetchFailed).toEqual(["2330.TW"])
  })

  it("separates 'not enough history' from 'could not fetch'", async () => {
    adapterFetch.mockResolvedValue(crossingSeries().slice(-8))   // < slow_period + 5
    findAlerts.mockResolvedValue([alertFor("u1", "telegram", "SPCX")])

    const r = await runScan()

    expect(r.insufficientData).toEqual(["SPCX"])
    expect(r.fetchFailed).toEqual([])
    expect(r.notified).toBe(0)
  })

  it("one symbol's failure does not stop the others", async () => {
    adapterFetch.mockImplementation(async (sym: string) => {
      if (sym === "2330.TW") throw new Error("Yahoo fetch failed: 429")
      return crossingSeries()
    })
    findAlerts.mockResolvedValue([
      alertFor("u1", "telegram", "2330.TW"),
      alertFor("u1", "telegram", "BTCUSDT"),
    ])

    const r = await runScan()

    expect(r.fetchFailed).toEqual(["2330.TW"])
    expect(r.notified).toBe(1)
  })
})
