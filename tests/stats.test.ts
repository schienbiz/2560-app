import { describe, it, expect } from "vitest"
import { computeStats } from "../src/engine/stats.js"
import type { TradeLike } from "../src/engine/stats.js"

describe("computeStats", () => {
  it("calculates win rate correctly", () => {
    const trades: TradeLike[] = [
      { entry_price: 100, exit_price: 120 },   // +20%  win
      { entry_price: 100, exit_price: 90  },   // -10%  loss
      { entry_price: 100, exit_price: 110 },   // +10%  win
      { entry_price: 100, exit_price: null },   // open
    ]
    const result = computeStats(trades)
    expect(result.total.count).toBe(4)
    expect(result.total.closed).toBe(3)
    expect(result.total.open).toBe(1)
    expect(result.total.wins).toBe(2)
    expect(result.total.winRate).toBeCloseTo(66.67, 1)
  })

  it("calculates average return correctly", () => {
    const trades: TradeLike[] = [
      { entry_price: 100, exit_price: 120 },  // +20%
      { entry_price: 100, exit_price: 80  },  // -20%
    ]
    const result = computeStats(trades)
    expect(result.total.avgReturn).toBeCloseTo(0)
  })

  it("groups by signal type", () => {
    const trades: TradeLike[] = [
      { entry_price: 100, exit_price: 120, signal_type: "golden_cross" },
      { entry_price: 100, exit_price: 90,  signal_type: "golden_cross" },
      { entry_price: 100, exit_price: 110, signal_type: "death_cross"  },
      { entry_price: 100, exit_price: 115, signal_type: null            },
    ]
    const result = computeStats(trades)
    expect(result.bySignal.golden_cross?.count).toBe(2)
    expect(result.bySignal.golden_cross?.winRate).toBeCloseTo(50)
    expect(result.bySignal.death_cross?.count).toBe(1)
    expect(result.bySignal.manual?.count).toBe(1)
  })

  it("handles no closed trades gracefully", () => {
    const trades: TradeLike[] = [
      { entry_price: 100, exit_price: null },
    ]
    const result = computeStats(trades)
    expect(result.total.closed).toBe(0)
    expect(Number.isNaN(result.total.winRate)).toBe(true)
    expect(Number.isNaN(result.total.avgReturn)).toBe(true)
  })

  it("handles empty trades array", () => {
    const result = computeStats([])
    expect(result.total.count).toBe(0)
    expect(Number.isNaN(result.total.winRate)).toBe(true)
  })

  it("tracks max win and max loss", () => {
    const trades: TradeLike[] = [
      { entry_price: 100, exit_price: 150 },   // +50%
      { entry_price: 100, exit_price: 60  },   // -40%
      { entry_price: 100, exit_price: 110 },   // +10%
    ]
    const result = computeStats(trades)
    expect(result.total.maxWin).toBeCloseTo(50)
    expect(result.total.maxLoss).toBeCloseTo(-40)
  })
})
