/**
 * runBacktest — the engine behind `GET /api/backtest/:symbol`.
 *
 * It had no test file at all, while producing the win rate, profit factor and
 * max drawdown the user reads off the app. Every fixture here uses MA2/MA3 on a
 * short series so each expected value can be worked out by hand and written
 * into the assertion, rather than pinning whatever the code happens to emit.
 *
 * MA2[i] = (c[i-1]+c[i])/2      (first value at i=1)
 * MA3[i] = (c[i-2]+c[i-1]+c[i])/3 (first value at i=2)
 */

import { describe, it, expect } from "vitest"
import { runBacktest } from "../src/engine/backtest.js"
import { scoreSignal } from "../src/engine/signal.js"
import { computeMA } from "../src/engine/ma.js"
import type { OHLCV } from "../src/engine/types.js"

const DAY = 86_400_000
const BASE = Date.UTC(2026, 0, 1)

/** Bars from a close series; volume is uniform unless overridden. */
function bars(closes: number[], volume: number | number[] = 1000): OHLCV[] {
  return closes.map((c, i) => ({
    date:   new Date(BASE + i * DAY).toISOString().slice(0, 10),
    open: c, high: c, low: c, close: c,
    volume: Array.isArray(volume) ? volume[i] : volume,
  }))
}

/**
 * One winning round trip then one losing one, under MA2/MA3.
 *
 *  i : 0  1  2  3  4   5  6  7  8  9  10 11 12  13 14 15
 *  c : 10 10 10 10 10  12 14 16 18 20 15 15 15  25 15 15
 *
 *  i=5  MA2=(10+12)/2=11    MA3=(10+10+12)/3=10.67  prev 10/10 → GOLDEN, entry 12
 *  i=10 MA2=(20+15)/2=17.5  MA3=(18+20+15)/3=17.67  prev 19/18 → DEATH,  exit 15  → +25%
 *  i=13 MA2=(15+25)/2=20    MA3=(15+15+25)/3=18.33  prev 15/15 → GOLDEN, entry 25
 *  i=15 MA2=(15+15)/2=15    MA3=(25+15+15)/3=18.33  prev 20/18.33 → DEATH, exit 15 → −40%
 */
const WIN_THEN_LOSS = [10, 10, 10, 10, 10, 12, 14, 16, 18, 20, 15, 15, 15, 25, 15, 15]

describe("runBacktest — trade detection", () => {
  it("pairs each golden cross with the next death cross", () => {
    const r = runBacktest("T", bars(WIN_THEN_LOSS), 2, 3)

    expect(r.trades).toHaveLength(2)
    expect(r.trades[0]).toMatchObject({
      entry_date: "2026-01-06", exit_date: "2026-01-11",   // i=5 → i=10
      entry_price: 12, exit_price: 15, holding_days: 5,
    })
    expect(r.trades[0].return_pct).toBeCloseTo(25, 10)     // (15−12)/12
    expect(r.trades[1]).toMatchObject({
      entry_date: "2026-01-14", exit_date: "2026-01-16",   // i=13 → i=15
      entry_price: 25, exit_price: 15, holding_days: 2,
    })
    expect(r.trades[1].return_pct).toBeCloseTo(-40, 10)    // (15−25)/25
  })

  it("honours the custom MA periods — 25/60 was once hard-coded inside", () => {
    // 16 bars cannot produce any MA60 value, so if the periods were ignored the
    // MA arrays would be all-null and this would find zero trades. Two trades
    // is proof the arguments reach computeMA.
    expect(runBacktest("T", bars(WIN_THEN_LOSS), 2, 3).trades).toHaveLength(2)
  })

  it("is long-only: a death cross with no open position opens nothing", () => {
    //  c : 20 10 10 10 10 10 10 10  → MA2 crosses BELOW MA3 early, never above
    const r = runBacktest("T", bars([20, 10, 10, 10, 10, 10, 10, 10]), 2, 3)
    expect(r.trades).toEqual([])
    expect(r.open_position).toBeNull()
  })

  it("does not pyramid: a second golden while already open must not move the entry", () => {
    /**
     * A second golden cross without an intervening death cross is reachable
     * because `isGolden` accepts p_fast <= p_slow (equality included) while
     * `isDeath` needs a strict <. So the fast MA can touch the slow one and
     * turn back up: a fresh entry signal with the position still open.
     *
     *  c :  10 10 10 10 10  12  14  10  20  10  10
     *  i=5   MA2=11    MA3=10.67                     → GOLDEN, entry 12
     *  i=7   MA2=(14+10)/2=12   MA3=(12+14+10)/3=12  → EQUAL: not a death cross
     *  i=8   MA2=(10+20)/2=15   MA3=(14+10+20)/3=14.67, prev 12<=12
     *                                                → GOLDEN again, still open
     *  i=10  MA2=(10+10)/2=10   MA3=(20+10+10)/3=13.33, prev 15>=13.33
     *                                                → DEATH, exit 10
     *
     * With the `!open` guard the trade is entry 12 → −16.7%. Without it the
     * entry is overwritten to 20 → −50%. The first version of this test used a
     * series with only one golden cross, so removing the guard changed nothing
     * and the mutant survived.
     */
    const r = runBacktest("T", bars([10, 10, 10, 10, 10, 12, 14, 10, 20, 10, 10]), 2, 3)

    expect(r.trades).toHaveLength(1)
    expect(r.trades[0].entry_date).toBe("2026-01-06")   // i=5, not i=9
    expect(r.trades[0].entry_price).toBe(12)            // not 20
    expect(r.trades[0].return_pct).toBeCloseTo((10 - 12) / 12 * 100, 10)
  })

  it("leaves a position open when no death cross follows", () => {
    //  c : 10 10 10 10 10 12 14 16 18 20 22 24 — one golden, then only upside.
    const r = runBacktest("T", bars([10, 10, 10, 10, 10, 12, 14, 16, 18, 20, 22, 24]), 2, 3)
    expect(r.trades).toEqual([])
    expect(r.open_position).toMatchObject({ entry_date: "2026-01-06", entry_price: 12 })
  })

  it("reports an unfinished position as open, marked against the last close", () => {
    const r = runBacktest("T", bars([10, 10, 10, 10, 10, 12, 14, 16, 18, 20, 22, 24]), 2, 3)
    // entry 12, last close 24 → +100%
    expect(r.open_position!.unrealized_pct).toBeCloseTo(100, 10)
    expect(r.win_count).toBe(0)   // an open position is not a result yet
    expect(r.cumulative).toEqual([])
  })
})

describe("runBacktest — the guard", () => {
  it("returns the empty shape below slowPeriod + 5 bars, without throwing", () => {
    const r = runBacktest("T", bars([1, 2, 3, 4, 5, 6, 7]), 2, 3)   // 7 < 3+5
    expect(r.bars).toBe(7)
    expect(r.trades).toEqual([])
    expect(r.win_rate).toBeNull()
    expect(r.profit_factor).toBeNull()
    expect(r.from_date).toBe("2026-01-01")
  })

  it("survives an empty series", () => {
    const r = runBacktest("T", [], 2, 3)
    expect(r.bars).toBe(0)
    expect(r.from_date).toBe("")
    expect(r.to_date).toBe("")
  })
})

describe("runBacktest — statistics (hand-computed from +25% and −40%)", () => {
  const r = runBacktest("T", bars(WIN_THEN_LOSS), 2, 3)

  it("counts wins and losses", () => {
    expect(r.win_count).toBe(1)
    expect(r.loss_count).toBe(1)
    expect(r.win_rate).toBeCloseTo(0.5, 10)
  })

  it("averages returns over all / winning / losing trades", () => {
    expect(r.avg_return).toBeCloseTo(-7.5, 10)   // (25 − 40)/2
    expect(r.avg_win).toBeCloseTo(25, 10)
    expect(r.avg_loss).toBeCloseTo(-40, 10)
    expect(r.best_trade).toBeCloseTo(25, 10)
    expect(r.worst_trade).toBeCloseTo(-40, 10)
  })

  it("profit factor is gross profit over gross loss", () => {
    expect(r.profit_factor).toBeCloseTo(25 / 40, 10)   // 0.625
  })

  it("expectancy is winRate·avgWin + lossRate·avgLoss", () => {
    expect(r.expectancy).toBeCloseTo(0.5 * 25 + 0.5 * -40, 2)   // −7.5
  })

  it("the equity curve compounds, one point per closed trade", () => {
    // 1 × 1.25 = 1.25, then × 0.60 = 0.75
    expect(r.cumulative).toEqual([1.25, 0.75])
  })

  it("max drawdown is peak-to-trough on that curve", () => {
    // peak 1.25 → trough 0.75 → (1.25 − 0.75)/1.25 = 40%
    expect(r.max_drawdown).toBeCloseTo(40, 2)
  })

  it("groups by confidence, counting only CLOSED trades", () => {
    // Both entries score 'low' here (see the confidence block below), so this
    // also pins that an open position never lands in these buckets.
    expect(r.by_confidence.low.count).toBe(2)
    expect(r.by_confidence.low.win_count).toBe(1)
    expect(r.by_confidence.low.win_rate).toBeCloseTo(0.5, 10)
    expect(r.by_confidence.high.count).toBe(0)
    expect(r.by_confidence.medium.count).toBe(0)
  })
})

describe("runBacktest — statistical edge cases that read as 'no data'", () => {
  /**
   * A strategy with no losing trade has an infinite profit factor, and the
   * result maps Infinity to null — the same value it uses for "there were no
   * trades at all". A caller cannot tell a flawless run from an empty one.
   * Pinned here because it is a reporting wart worth deciding about, not an
   * accident to be silently changed.
   */
  it("all-wins reports profit_factor null — indistinguishable from no trades", () => {
    //  c : 10 10 10 10 10 12 14 16 18 20 15 15 15  → the +25% trade alone
    const r = runBacktest("T", bars(WIN_THEN_LOSS.slice(0, 13)), 2, 3)
    expect(r.trades).toHaveLength(1)
    expect(r.trades[0].return_pct).toBeCloseTo(25, 10)
    expect(r.profit_factor).toBeNull()                       // was Infinity
    expect(runBacktest("T", [], 2, 3).profit_factor).toBeNull()   // same value
  })

  it("expectancy is null when there is nothing to average on one side", () => {
    const r = runBacktest("T", bars(WIN_THEN_LOSS.slice(0, 13)), 2, 3)
    expect(r.avg_loss).toBeNull()
    expect(r.expectancy).toBeNull()
  })

  it("a flat 0% trade counts as a LOSS, not a win", () => {
    //  c : 10 10 10 10 10 12 14 16 18 20 12 12 12
    //  i=5  GOLDEN entry 12   (as above)
    //  i=10 MA2=(20+12)/2=16  MA3=(18+20+12)/3=16.67  prev 19/18 → DEATH exit 12
    //  → return exactly 0%
    const r = runBacktest("T", bars([10, 10, 10, 10, 10, 12, 14, 16, 18, 20, 12, 12, 12]), 2, 3)
    expect(r.trades).toHaveLength(1)
    expect(r.trades[0].return_pct).toBeCloseTo(0, 10)
    expect(r.win_count).toBe(0)
    expect(r.loss_count).toBe(1)
    expect(r.win_rate).toBe(0)
  })
})

describe("runBacktest — the first evaluable cross is deliberately skipped", () => {
  /**
   * The loop starts at `slowPeriod + 1`, so the transition at index
   * `slowPeriod` — whose "previous" point is the very first MA value, the one
   * produced as the average just switches on — is never examined. That is
   * defensible (it is the same MA-initialisation artefact `hasSufficientBars`
   * guards against) but it is undocumented in the source, and it means a
   * backtest can silently miss a cross the live scanner would take.
   *
   * Pinned so a future refactor has to decide about it on purpose.
   */
  it("a genuine golden cross at index slowPeriod produces no trade", () => {
    //  c : 20 10 10 20 10 10 10 10
    //  i=2  MA2=(10+10)/2=10      MA3=(20+10+10)/3=13.33
    //  i=3  MA2=(10+20)/2=15      MA3=(10+10+20)/3=13.33   → 10≤13.33 then 15>13.33
    const closes = [20, 10, 10, 20, 10, 10, 10, 10]
    const ma2 = computeMA(closes, 2)
    const ma3 = computeMA(closes, 3)

    // The fixture really does cross at i=3 — asserted on the hand-computed MAs,
    // so this is not circular with the code under test.
    expect(ma2[2]!).toBeCloseTo(10, 10)
    expect(ma3[2]!).toBeCloseTo(40 / 3, 10)
    expect(ma2[3]!).toBeCloseTo(15, 10)
    expect(ma3[3]!).toBeCloseTo(40 / 3, 10)
    expect(ma2[2]! <= ma3[2]! && ma2[3]! > ma3[3]!).toBe(true)   // a golden cross at i=3

    expect(runBacktest("T", bars(closes), 2, 3).trades).toEqual([])
    expect(runBacktest("T", bars(closes), 2, 3).open_position).toBeNull()
  })
})

describe("runBacktest — confidence scoring", () => {
  it("scores the four factors at the CROSS bar, not the latest bar", () => {
    // Volume spike ONLY on the entry bar (i=5). If the factor were read at the
    // last bar it would not see it.
    const vols = Array(16).fill(1000)
    vols[5] = 5000                                     // 5000 > 1000 × 1.2
    const r = runBacktest("T", bars(WIN_THEN_LOSS, vols), 2, 3)
    expect(r.trades[0].factors_passed).toBe(2)         // volume + proximity
    expect(r.trades[0].confidence).toBe("medium")      // raw count ≥ 2
    expect(r.trades[1].factors_passed).toBe(0)         // no spike, price far from MA3
    expect(r.trades[1].confidence).toBe("low")
  })

  it("proximity passes within 15% of the slow MA and fails outside it", () => {
    const r = runBacktest("T", bars(WIN_THEN_LOSS), 2, 3)
    // entry i=5:  |12 − 10.67| / 10.67 = 12.5%  → inside
    expect(r.trades[0].factors_passed).toBe(1)
    // entry i=13: |25 − 18.33| / 18.33 = 36.4%  → outside
    expect(r.trades[1].factors_passed).toBe(0)
  })

  /**
   * KNOWN DIVERGENCE from the live engine, pinned rather than assumed.
   *
   * `scoreSignal` treats a factor with no history (RSI needs 15 bars, MACD 34)
   * as INAPPLICABLE and drops it from the denominator, precisely so a strong
   * cross on a short series is not capped. The backtest instead scores it
   * `false` — a plain failure — so the same cross is graded lower here than the
   * app grades it live. With the default 25/60 the loop never starts before bar
   * 61 and all four factors always apply, so the two agree; it only bites the
   * custom short periods the route permits (slow_period as low as 3).
   *
   * That matters because `by_confidence` is read as "how do high-confidence
   * signals perform" — and "high" does not mean the same thing in both places.
   */
  it("grades a short-history cross lower than the live engine does", () => {
    const closes = WIN_THEN_LOSS.slice(0, 6)      // cross at the LAST bar (i=5)
    const series = bars(closes)
    const live = scoreSignal(series, computeMA(closes, 2), computeMA(closes, 3), 1)

    expect(live.signal).toBe("golden_cross")
    // Live: volume applies (avg > 0) and fails, proximity applies and passes,
    // RSI/MACD have no history → excluded. 1 of 2 applicable = 50% → medium.
    expect(live.confidence).toBe("medium")

    // Backtest, same bar: RSI and MACD counted as failed → 1 of 4 → low.
    const bt = runBacktest("T", bars(WIN_THEN_LOSS), 2, 3)
    expect(bt.trades[0].factors_passed).toBe(1)
    expect(bt.trades[0].confidence).toBe("low")
  })

  it("agrees with the live engine once all four factors apply", () => {
    // Long enough for MACD (34 bars) and RSI (15), so nothing is inapplicable
    // and the two grading rules should land on the same label.
    //   40 flat bars at 100, then 104 → MA2=(100+104)/2=102 vs
    //   MA3=(100+100+104)/3=101.33, previous pair 100/100 → golden at i=40.
    // At that bar: volume spike ✓, |104−101.33|/101.33 = 2.6% ✓,
    // RSI rising off a flat base ✓, MACD histogram positive ✓ → 4 of 4.
    const closes = [...Array(40).fill(100), 104, 108, 100, 100, 100]
    const vols = Array(closes.length).fill(1000)
    vols[40] = 9000

    const bt = runBacktest("T", bars(closes, vols), 2, 3)
    expect(bt.trades[0].entry_date).toBe(new Date(BASE + 40 * DAY).toISOString().slice(0, 10))
    expect(bt.trades[0].factors_passed).toBe(4)
    expect(bt.trades[0].confidence).toBe("high")

    // Same bar through the live engine: truncate so the cross IS the last bar.
    const upTo = closes.slice(0, 41)
    const live = scoreSignal(
      bars(upTo, vols.slice(0, 41)),
      computeMA(upTo, 2), computeMA(upTo, 3), 1
    )
    expect(live.signal).toBe("golden_cross")
    expect(live.confidence).toBe(bt.trades[0].confidence)   // both "high"
  })
})
