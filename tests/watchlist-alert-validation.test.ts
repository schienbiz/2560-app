import { describe, it, expect } from "vitest"

// Mirrors the server-side validation logic in PUT /api/watchlist/:id/alert.
// Tests the guard conditions without requiring a live DB.

function validateMaPair(
  fast_period: number | undefined,
  slow_period: number | undefined,
  existingFast = 25,
  existingSlow = 60
): { ok: boolean; error?: string } {
  if (fast_period !== undefined && slow_period !== undefined) {
    if (fast_period >= slow_period) return { ok: false, error: "慢線 MA 必須大於快線 MA" }
  }
  if (fast_period !== undefined && slow_period === undefined) {
    if (fast_period >= existingSlow) return { ok: false, error: "慢線 MA 必須大於快線 MA" }
  }
  if (slow_period !== undefined && fast_period === undefined) {
    if (existingFast >= slow_period) return { ok: false, error: "慢線 MA 必須大於快線 MA" }
  }
  return { ok: true }
}

describe("MA pair validation", () => {
  it("accepts valid fast < slow", () => {
    expect(validateMaPair(5, 20).ok).toBe(true)
    expect(validateMaPair(25, 60).ok).toBe(true)
    expect(validateMaPair(50, 200).ok).toBe(true)
  })

  it("rejects fast === slow", () => {
    const result = validateMaPair(50, 50)
    expect(result.ok).toBe(false)
    expect(result.error).toBe("慢線 MA 必須大於快線 MA")
  })

  it("rejects fast > slow", () => {
    const result = validateMaPair(60, 25)
    expect(result.ok).toBe(false)
  })

  it("accepts updating only fast_period when it stays below existing slow", () => {
    // existing slow = 60, new fast = 5 → valid
    expect(validateMaPair(5, undefined, 25, 60).ok).toBe(true)
  })

  it("rejects updating only fast_period to match existing slow", () => {
    // existing slow = 60, new fast = 60 → invalid
    const result = validateMaPair(60, undefined, 25, 60)
    expect(result.ok).toBe(false)
  })

  it("accepts updating only slow_period when it stays above existing fast", () => {
    // existing fast = 25, new slow = 100 → valid
    expect(validateMaPair(undefined, 100, 25, 60).ok).toBe(true)
  })

  it("rejects updating only slow_period to below existing fast", () => {
    // existing fast = 25, new slow = 20 → invalid
    const result = validateMaPair(undefined, 20, 25, 60)
    expect(result.ok).toBe(false)
  })

  it("accepts updating only slow_period to match existing fast (edge: equal not allowed)", () => {
    // existing fast = 25, new slow = 25 → invalid (must be strictly greater)
    const result = validateMaPair(undefined, 25, 25, 60)
    expect(result.ok).toBe(false)
  })

  it("passes through when neither period is provided", () => {
    expect(validateMaPair(undefined, undefined).ok).toBe(true)
  })
})
