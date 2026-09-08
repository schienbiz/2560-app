/**
 * Telegram delivery safety.
 *
 * Measured against the live Bot API on 2026-09-07 (chat_id=1, so nothing was
 * delivered to anyone):
 *   text "RSI<50 動能轉弱"  parse_mode=HTML → 400 can't parse entities:
 *                                             Unsupported start tag "50"
 *   text "量價 A&B 背離"    parse_mode=HTML → parsed fine (400 chat not found)
 *   text "價格 > MA60 上方"  parse_mode=HTML → parsed fine (400 chat not found)
 * The rejection happens BEFORE the chat is resolved, so the whole message is
 * lost — and in the push path the resulting throw was swallowed by runScan's
 * Promise.allSettled while the workflow stayed green.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { pushTelegram } from "../cron/notify.js"
import { clampMessage, TELEGRAM_TEXT_LIMIT } from "../src/utils/message.js"
import { escapeHtml } from "../src/webhooks/telegram.js"

interface SentBody { chat_id: string; text: string; parse_mode?: string }

function captureFetch(status = 200) {
  const calls: SentBody[] = []
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string))
    return { ok: status < 400, status, text: async () => "err" } as Response
  }))
  return calls
}

describe("pushTelegram", () => {
  beforeEach(() => { vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token") })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

  it("sends NO parse_mode — free-form AI text must not be parsed as markup", async () => {
    const calls = captureFetch()
    await pushTelegram("123", "🔴 2330 死亡交叉\nRSI<50 動能轉弱")
    expect(calls[0].parse_mode).toBeUndefined()
  })

  it("delivers a body containing '<' verbatim instead of losing the message", async () => {
    const calls = captureFetch()
    await pushTelegram("123", "RSI<50 動能轉弱")
    expect(calls[0].text).toBe("RSI<50 動能轉弱")
  })

  it("still surfaces a rejected push as a throw the caller can count", async () => {
    captureFetch(400)
    await expect(pushTelegram("123", "hi")).rejects.toThrow(/Telegram push failed: 400/)
  })

  it("clamps to the platform cap so an over-long digest degrades instead of vanishing", async () => {
    const calls = captureFetch()
    await pushTelegram("123", "x".repeat(TELEGRAM_TEXT_LIMIT + 500))
    expect(calls[0].text.length).toBe(TELEGRAM_TEXT_LIMIT)
    expect(calls[0].text.endsWith("…")).toBe(true)
  })
})

describe("escapeHtml — for the curated replies that DO use HTML", () => {
  it("escapes the character that actually breaks the parser", () => {
    expect(escapeHtml("RSI<50")).toBe("RSI&lt;50")
  })

  it("escapes & and > too, so escaped text round-trips", () => {
    expect(escapeHtml("A&B > C")).toBe("A&amp;B &gt; C")
  })

  it("escapes the ampersand first — never double-escapes into &amp;lt;", () => {
    expect(escapeHtml("<b>")).toBe("&lt;b&gt;")
  })

  it("leaves ordinary Chinese notification text untouched", () => {
    const s = "🔴 2330.TW 死亡交叉 · 收盤 1,850"
    expect(escapeHtml(s)).toBe(s)
  })
})

describe("clampMessage", () => {
  it("never cuts an emoji in half — a lone surrogate is invalid UTF-8 and 400s", () => {
    // "🔴" is one code point but TWO UTF-16 units. Sweep every limit rather
    // than picking one: with "a" + 🔴…, only the limits where limit-1 lands on
    // a high surrogate expose the naive `slice(limit - 1)`, and the first
    // version of this test happened to choose a limit that did not.
    const msg = "a" + "🔴".repeat(10)
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

    for (let limit = 2; limit <= msg.length; limit++) {
      const out = clampMessage(msg, limit)
      expect(out.length).toBeLessThanOrEqual(limit)
      expect({ limit, lone: loneSurrogate.test(out) }).toEqual({ limit, lone: false })
    }
  })

  it("passes an in-limit message through untouched", () => {
    expect(clampMessage("short", 100)).toBe("short")
  })
})
