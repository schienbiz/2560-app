/**
 * Unit tests for signals route logic (limit parsing).
 *
 * The full route requires Hono + Prisma + auth middleware — too heavy to mock
 * here. We test only the limit-parsing logic extracted from the route.
 */

import { describe, it, expect } from "vitest"

// Inline the limit-parsing logic from src/routes/signals.ts for unit testing
function parseLimit(limitParam: string | undefined): number {
  return Math.min(parseInt(limitParam ?? "30", 10) || 30, 100)
}

describe("GET /api/signals — limit parsing", () => {
  it("defaults to 30 when param is undefined", () => {
    expect(parseLimit(undefined)).toBe(30)
  })

  it("uses custom limit when provided", () => {
    expect(parseLimit("50")).toBe(50)
  })

  it("clamps to 100 when limit exceeds cap", () => {
    expect(parseLimit("200")).toBe(100)
  })

  it("falls back to 30 on NaN input", () => {
    expect(parseLimit("abc")).toBe(30)
  })

  it("falls back to 30 on empty string", () => {
    expect(parseLimit("")).toBe(30)
  })

  it("handles limit of exactly 100 (boundary)", () => {
    expect(parseLimit("100")).toBe(100)
  })

  it("handles limit of 1 (minimum useful value)", () => {
    expect(parseLimit("1")).toBe(1)
  })
})
