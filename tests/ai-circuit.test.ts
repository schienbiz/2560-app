/**
 * A retired model id must stop being called.
 *
 * NVIDIA's gpt-oss-120b answered 410 Gone from 2026-09-03 and stayed in the
 * chain for six weeks: every chat() paid a round-trip to it, and nothing in the
 * logs looked different from an ordinary provider hiccup. Only 429 and 402
 * opened the circuit; 404/410 — the shapes a removed model actually takes —
 * did not.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const calls: string[] = []

beforeEach(() => {
  calls.length = 0
  vi.stubEnv("GROQ_API_KEY", "test")
  vi.stubEnv("NVIDIA_API_KEY", "")
  vi.stubEnv("OPENROUTER_API_KEY", "")
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { model } = JSON.parse(init.body) as { model: string }
    calls.push(model)
    // The first provider in the chain is retired; the second one works.
    if (model === "openai/gpt-oss-120b") {
      return new Response(JSON.stringify({ status: 410, title: "Gone" }), { status: 410 })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("provider circuit on a retired model", () => {
  it("falls through on 410 and does not call the dead model again", async () => {
    const { chat } = await import("../src/services/ai.js")

    expect(await chat("q1")).toBe("ok")
    expect(await chat("q2")).toBe("ok")

    expect(calls.filter(m => m === "openai/gpt-oss-120b")).toHaveLength(1)
    expect(calls.filter(m => m === "qwen/qwen3.8-27b")).toHaveLength(2)
  })
})
