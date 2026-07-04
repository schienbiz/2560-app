import { describe, it, expect } from "vitest"
import { normalizeYahooBars } from "../src/adapters/yahoo.js"

// Yahoo returns per-field null on partial bars. normalizeYahooBars must never
// emit a 0 for high/low/open on a bar that has a valid close — a phantom 0 low
// becomes a support level at price 0 (sr.ts) and blows up ATR (structure.ts).

const ts = (d: string) => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000)

describe("normalizeYahooBars", () => {
  it("backfills a null low/high/open from the close, never 0", () => {
    const timestamp = [ts("2026-01-02")]
    const quote = {
      open:   [null],
      high:   [null],
      low:    [null],
      close:  [185.5],
      volume: [null],
    }
    const [bar] = normalizeYahooBars(timestamp, quote, 10)
    expect(bar.close).toBe(185.5)
    expect(bar.open).toBe(185.5)   // was `?? 0` before → would have been 0
    expect(bar.high).toBe(185.5)
    expect(bar.low).toBe(185.5)
    expect(bar.volume).toBe(0)     // missing volume is genuinely 0 (neutral)
    // The corruption the fix prevents:
    expect(bar.low).not.toBe(0)
    expect(bar.high).not.toBe(0)
  })

  it("treats a non-positive high/low as missing and backfills from close", () => {
    const [bar] = normalizeYahooBars([ts("2026-01-02")], {
      open:  [10], high: [0], low: [-1], close: [10], volume: [100],
    }, 10)
    expect(bar.high).toBe(10)
    expect(bar.low).toBe(10)
  })

  it("drops bars with a null or non-positive close", () => {
    const timestamp = [ts("2026-01-02"), ts("2026-01-03"), ts("2026-01-06")]
    const quote = {
      open:   [10,   null, 12],
      high:   [11,   null, 13],
      low:    [9,    null, 11],
      close:  [10.5, null, 12.5],   // middle bar has no close → dropped
      volume: [100,  200,  300],
    }
    const bars = normalizeYahooBars(timestamp, quote, 10)
    expect(bars).toHaveLength(2)
    expect(bars.map(b => b.date)).toEqual(["2026-01-02", "2026-01-06"])
  })

  it("passes clean bars through unchanged and trims to `days`", () => {
    const timestamp = [ts("2026-01-02"), ts("2026-01-03"), ts("2026-01-06")]
    const quote = {
      open:   [10, 11, 12],
      high:   [11, 12, 13],
      low:    [9,  10, 11],
      close:  [10, 11, 12],
      volume: [100, 110, 120],
    }
    const bars = normalizeYahooBars(timestamp, quote, 2)  // keep last 2
    expect(bars).toHaveLength(2)
    expect(bars[0]).toEqual({ date: "2026-01-03", open: 11, high: 12, low: 10, close: 11, volume: 110 })
    expect(bars[1].close).toBe(12)
  })
})
