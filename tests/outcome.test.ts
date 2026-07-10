import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the data layer before importing the module under test.
const findManySignals = vi.fn()
const updateSignal = vi.fn()
const findManyOhlcv = vi.fn()

vi.mock("../src/db.js", () => ({
  db: {
    signalHistory: {
      findMany: (...args: unknown[]) => findManySignals(...args),
      update: (...args: unknown[]) => updateSignal(...args),
    },
    ohlcvCache: {
      findMany: (...args: unknown[]) => findManyOhlcv(...args),
    },
  },
}))

import {
  addDays, firstCloseOnOrAfter, windowReturns, benchmarkBase,
  WINDOW_CAL_DAYS, BENCHMARK_BASE_MAX_LAG_DAYS,
} from "../src/utils/outcome-math.js"
import type { PriceBar } from "../src/utils/outcome-math.js"
import { runOutcome } from "../cron/outcome.js"

const SIGNAL = new Date("2026-06-01T00:00:00.000Z")

/** Daily bars from `signalDate` for `n` calendar days, close = 100 + day offset. */
function dailyBars(n: number, from = SIGNAL, base = 100): PriceBar[] {
  return Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), close: base + i }))
}

// ─── windowReturns ───────────────────────────────────────────────────────────

describe("windowReturns", () => {
  it("takes the first close on/after each +7/+14/+28 calendar-day target", () => {
    const rows = dailyBars(34) // close at +7d = 107, +14d = 114, +28d = 128
    const r = windowReturns(rows, 100, SIGNAL)
    expect(r.d5).toBeCloseTo(7)
    expect(r.d10).toBeCloseTo(14)
    expect(r.d20).toBeCloseTo(28)
  })

  it("skips a weekend hole to the next available bar", () => {
    // no bar exactly at +7d: next bar is +9d (close 109)
    const rows = dailyBars(34).filter(b => b.date.getTime() !== addDays(SIGNAL, 7).getTime()
      && b.date.getTime() !== addDays(SIGNAL, 8).getTime())
    expect(windowReturns(rows, 100, SIGNAL).d5).toBeCloseTo(9)
  })

  it("returns null for windows beyond the available data instead of guessing", () => {
    const rows = dailyBars(10) // covers +7d only
    const r = windowReturns(rows, 100, SIGNAL)
    expect(r.d5).toBeCloseTo(7)
    expect(r.d10).toBeNull()
    expect(r.d20).toBeNull()
  })
})

// ─── benchmarkBase ───────────────────────────────────────────────────────────

describe("benchmarkBase", () => {
  it("uses the first bar on/after the signal date", () => {
    expect(benchmarkBase(dailyBars(5), SIGNAL)).toBe(100)
  })

  it("tolerates a short holiday lag but rejects a cache gap", () => {
    const holiday = dailyBars(5, addDays(SIGNAL, BENCHMARK_BASE_MAX_LAG_DAYS))
    expect(benchmarkBase(holiday, SIGNAL)).toBe(100)
    const gap = dailyBars(5, addDays(SIGNAL, BENCHMARK_BASE_MAX_LAG_DAYS + 1))
    expect(benchmarkBase(gap, SIGNAL)).toBeNull()
    expect(benchmarkBase([], SIGNAL)).toBeNull()
  })
})

// ─── runOutcome ──────────────────────────────────────────────────────────────

describe("runOutcome", () => {
  beforeEach(() => {
    findManySignals.mockReset()
    updateSignal.mockReset()
    findManyOhlcv.mockReset()
    updateSignal.mockResolvedValue(undefined)
  })

  const entry = {
    id: "sig1",
    symbol: "PYPL",
    asset_type: "stock",
    signal: "death_cross",
    signal_date: SIGNAL,
    close_price: 100,
    outcome_5d: null, outcome_10d: null, outcome_20d: null,
    benchmark_5d: null, benchmark_10d: null, benchmark_20d: null,
  }

  it("selects rows whose 20d outcome OR benchmark is still missing, inside the age window", async () => {
    findManySignals.mockResolvedValue([])
    await runOutcome()
    const where = findManySignals.mock.calls[0][0].where
    expect(where.OR).toEqual([{ outcome_20d: null }, { benchmark_20d: null }])
    expect(where.signal_date.lte).toBeInstanceOf(Date)
    expect(where.signal_date.gte).toBeInstanceOf(Date)
    // eligibility ordering: stale cutoff (gte) is older than maturity cutoff (lte)
    expect(where.signal_date.gte.getTime()).toBeLessThan(where.signal_date.lte.getTime())
  })

  it("fills outcomes and SPY benchmark for a US stock, and stamps outcome_computed_at", async () => {
    findManySignals.mockResolvedValue([entry])
    findManyOhlcv.mockImplementation(({ where }: { where: { symbol: string } }) =>
      Promise.resolve(where.symbol === "PYPL" ? dailyBars(34, SIGNAL, 100) : dailyBars(34, SIGNAL, 200)))
    await runOutcome()

    // benchmark routed to SPY (us bucket), not the symbol itself
    const queried = findManyOhlcv.mock.calls.map(c => c[0].where.symbol).sort()
    expect(queried).toEqual(["PYPL", "SPY"])

    const data = updateSignal.mock.calls[0][0].data
    expect(data.outcome_5d).toBeCloseTo(7)                            // (107-100)/100
    expect(data.outcome_20d).toBeCloseTo(28)
    expect(data.benchmark_5d).toBeCloseTo((207 - 200) / 200 * 100)    // index base 200
    expect(data.benchmark_20d).toBeCloseTo((228 - 200) / 200 * 100)
    expect(data.outcome_computed_at).toBeInstanceOf(Date)
  })

  it("never overwrites previously stored values (second pass fills only the gaps)", async () => {
    // first pass stored outcome_5d = -7.73; later bars now allow 10d/20d
    findManySignals.mockResolvedValue([{ ...entry, outcome_5d: -7.73 }])
    findManyOhlcv.mockImplementation(({ where }: { where: { symbol: string } }) =>
      Promise.resolve(where.symbol === "PYPL" ? dailyBars(34) : dailyBars(34, SIGNAL, 200)))
    await runOutcome()

    const data = updateSignal.mock.calls[0][0].data
    expect(data.outcome_5d).toBe(-7.73)       // preserved, not recomputed to +7
    expect(data.outcome_10d).toBeCloseTo(14)  // gap filled
    expect(data.outcome_20d).toBeCloseTo(28)
  })

  it("leaves benchmarks null (not fabricated) when the index cache has a gap at the base", async () => {
    findManySignals.mockResolvedValue([entry])
    findManyOhlcv.mockImplementation(({ where }: { where: { symbol: string } }) =>
      Promise.resolve(where.symbol === "PYPL"
        ? dailyBars(34)
        : dailyBars(10, addDays(SIGNAL, BENCHMARK_BASE_MAX_LAG_DAYS + 3), 200)))
    await runOutcome()

    const data = updateSignal.mock.calls[0][0].data
    expect(data.outcome_5d).toBeCloseTo(7)
    expect(data.benchmark_5d).toBeNull()
    expect(data.benchmark_20d).toBeNull()
  })

  it("routes TW symbols to 0050.TW and crypto to BTCUSDT", async () => {
    findManySignals.mockResolvedValue([
      { ...entry, id: "s2", symbol: "2308.TW", asset_type: "stock" },
      { ...entry, id: "s3", symbol: "ETHUSDT", asset_type: "crypto" },
    ])
    findManyOhlcv.mockResolvedValue([])
    await runOutcome()
    const queried = findManyOhlcv.mock.calls.map(c => c[0].where.symbol)
    expect(queried).toContain("0050.TW")
    expect(queried).toContain("BTCUSDT")
  })

  it("one failing row does not block the rest of the batch", async () => {
    findManySignals.mockResolvedValue([
      { ...entry, id: "bad" },
      { ...entry, id: "good", symbol: "HOOD" },
    ])
    findManyOhlcv.mockImplementation(({ where }: { where: { symbol: string } }) => {
      if (where.symbol === "PYPL") return Promise.reject(new Error("boom"))
      return Promise.resolve(dailyBars(34))
    })
    await runOutcome()
    const updatedIds = updateSignal.mock.calls.map(c => c[0].where.id)
    expect(updatedIds).toEqual(["good"])
  })
})

// ─── firstCloseOnOrAfter (regression: exact-date boundary) ───────────────────

describe("firstCloseOnOrAfter", () => {
  it("includes a bar exactly on the target date", () => {
    const rows = [{ date: addDays(SIGNAL, WINDOW_CAL_DAYS.d5), close: 111 }]
    expect(firstCloseOnOrAfter(rows, addDays(SIGNAL, 7))).toBe(111)
  })
})
