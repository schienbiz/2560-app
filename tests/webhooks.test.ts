/**
 * The two bot webhooks — the only unauthenticated write surfaces in the app.
 *
 * Neither had a test file. The signature checks here are the whole perimeter:
 * anyone who gets past them can add to or delete from a watchlist. And the
 * Telegram side is where a `<` in an AI reply silently destroyed the whole
 * message until v1.7.0 — measured against the live Bot API, `parse_mode: HTML`
 * answers `400 can't parse entities` and the rejection happens before the chat
 * is even resolved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createHmac } from "node:crypto"

vi.mock("../src/services/ai.js", () => ({
  chatWithContext: async () => "分析結果",
  hasAnyProviderKey: () => true,
}))
vi.mock("../src/services/bot-context.js", () => ({ getUserContext: async () => ({}) }))
vi.mock("../src/db.js", () => ({ db: { watchlist: { findMany: async () => [], findFirst: async () => null } } }))

import { handleLineWebhook } from "../src/webhooks/line.js"
import { handleTelegramWebhook, escapeHtml } from "../src/webhooks/telegram.js"

const LINE_SECRET = "8fab-test-channel-secret"
const TG_SECRET   = "tg-webhook-secret"

/** Minimal Hono-ish context: only what these handlers actually touch. */
function ctx(body: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    req: {
      header: (n: string) => lower[n.toLowerCase()],
      text:   async () => body,
      json:   async () => JSON.parse(body),
    },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
  } as never
}

const lineSig = (body: string, secret = LINE_SECRET) =>
  createHmac("sha256", secret).update(body).digest("base64")

describe("LINE webhook signature", () => {
  beforeEach(() => {
    vi.stubEnv("LINE_CHANNEL_SECRET", LINE_SECRET)
    vi.stubEnv("GROQ_API_KEY", "k")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "" })))
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it("accepts a correctly signed body", async () => {
    const body = JSON.stringify({ events: [] })
    const res = await handleLineWebhook(ctx(body, { "X-Line-Signature": lineSig(body) }))
    expect(res.status).toBe(200)
  })

  it("rejects a body signed with the wrong secret", async () => {
    const body = JSON.stringify({ events: [] })
    const res = await handleLineWebhook(ctx(body, { "X-Line-Signature": lineSig(body, "not-the-secret") }))
    expect(res.status).toBe(401)
  })

  it("rejects a body that was modified after signing", async () => {
    const signed = JSON.stringify({ events: [] })
    const res = await handleLineWebhook(
      ctx(JSON.stringify({ events: [{ type: "message" }] }), { "X-Line-Signature": lineSig(signed) }))
    expect(res.status).toBe(401)
  })

  it("rejects a missing signature", async () => {
    const body = JSON.stringify({ events: [] })
    expect((await handleLineWebhook(ctx(body))).status).toBe(401)
  })

  it("rejects a signature of the wrong length rather than throwing", async () => {
    // timingSafeEqual throws on differing lengths — the guard in front of it is
    // what turns that into a clean 401.
    const body = JSON.stringify({ events: [] })
    expect((await handleLineWebhook(ctx(body, { "X-Line-Signature": "short" }))).status).toBe(401)
  })

  it("rejects everything when no channel secret is configured", async () => {
    vi.stubEnv("LINE_CHANNEL_SECRET", "")
    const body = JSON.stringify({ events: [] })
    expect((await handleLineWebhook(ctx(body, { "X-Line-Signature": lineSig(body) }))).status).toBe(401)
  })
})

describe("Telegram webhook secret", () => {
  beforeEach(() => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", TG_SECRET)
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot-token")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "" })))
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  const update = JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: "hi" } })

  it("accepts the configured secret header", async () => {
    const res = await handleTelegramWebhook(ctx(update, { "X-Telegram-Bot-Api-Secret-Token": TG_SECRET }))
    expect(res.status).toBe(200)
  })

  it("rejects a wrong secret", async () => {
    const res = await handleTelegramWebhook(ctx(update, { "X-Telegram-Bot-Api-Secret-Token": "wrong" }))
    expect(res.status).toBe(401)
  })

  it("rejects a missing secret header", async () => {
    expect((await handleTelegramWebhook(ctx(update))).status).toBe(401)
  })

  it("rejects a secret of a different length rather than throwing", async () => {
    const res = await handleTelegramWebhook(ctx(update, { "X-Telegram-Bot-Api-Secret-Token": "x" }))
    expect(res.status).toBe(401)
  })

  /**
   * Documented fail-open: with no secret configured the endpoint is wide open,
   * and anyone who knows the URL can drive the bot's watchlist commands. Both
   * live backends do set it (verified via the Render API), so this pins the
   * behaviour rather than reporting an exposure.
   */
  it("is OPEN when no webhook secret is configured — fail-open, by construction", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "")
    expect((await handleTelegramWebhook(ctx(update, {}))).status).toBe(200)
  })

  it("acknowledges a malformed body instead of erroring — Telegram retries a non-200", async () => {
    const res = await handleTelegramWebhook(ctx("not json", { "X-Telegram-Bot-Api-Secret-Token": TG_SECRET }))
    expect(res.status).toBe(200)
  })

  it("acknowledges an update with no text (a sticker, a photo)", async () => {
    const noText = JSON.stringify({ update_id: 2, message: { message_id: 2, chat: { id: 1 }, from: { id: 1 } } })
    expect((await handleTelegramWebhook(ctx(noText, { "X-Telegram-Bot-Api-Secret-Token": TG_SECRET }))).status).toBe(200)
  })
})

describe("escapeHtml — the character that silently destroyed messages", () => {
  it("escapes `<`, the one the Bot API actually rejects", () => {
    // Measured against the live API: "RSI<50 動能轉弱" with parse_mode HTML →
    // 400 can't parse entities: Unsupported start tag "50", and the rejection
    // lands before the chat is resolved, so the whole message is lost.
    expect(escapeHtml("RSI<50 動能轉弱")).toBe("RSI&lt;50 動能轉弱")
  })

  it("escapes & first, so nothing double-escapes", () => {
    expect(escapeHtml("<b>A&B</b>")).toBe("&lt;b&gt;A&amp;B&lt;/b&gt;")
  })

  it("leaves ordinary notification text untouched", () => {
    const s = "🔴 2330.TW 死亡交叉 · 收盤 1,850"
    expect(escapeHtml(s)).toBe(s)
  })

  it("neutralises a user-chosen label that contains markup", () => {
    // watchlist labels are free text and are interpolated into the /清單 reply.
    expect(escapeHtml("<script>alert(1)</script>"))
      .toBe("&lt;script&gt;alert(1)&lt;/script&gt;")
  })
})
