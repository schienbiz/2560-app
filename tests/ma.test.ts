import { describe, it, expect } from "vitest"
import { computeMA, lastN } from "../src/engine/ma.js"

describe("computeMA", () => {
  it("returns null for indices before period is reached", () => {
    const result = computeMA([1, 2, 3, 4, 5], 3)
    expect(result[0]).toBeNull()
    expect(result[1]).toBeNull()
    expect(result[2]).not.toBeNull()
  })

  it("computes correct 3-period SMA", () => {
    const result = computeMA([1, 2, 3, 4, 5], 3)
    expect(result[2]).toBeCloseTo(2)   // (1+2+3)/3
    expect(result[3]).toBeCloseTo(3)   // (2+3+4)/3
    expect(result[4]).toBeCloseTo(4)   // (3+4+5)/3
  })

  it("returns single value for period=1", () => {
    const result = computeMA([10, 20, 30], 1)
    expect(result).toEqual([10, 20, 30])
  })

  it("handles a flat price series", () => {
    const prices = Array(10).fill(100)
    const result = computeMA(prices, 5)
    result.slice(4).forEach(v => expect(v).toBeCloseTo(100))
  })

  it("returns all nulls when prices shorter than period", () => {
    const result = computeMA([1, 2], 5)
    expect(result).toEqual([null, null])
  })
})

describe("lastN", () => {
  it("extracts last N non-null values", () => {
    const series = [null, null, 1, 2, 3]
    expect(lastN(series, 2)).toEqual([2, 3])
  })

  it("returns empty array when fewer than N non-null values", () => {
    expect(lastN([null, null], 2)).toEqual([])
  })
})
