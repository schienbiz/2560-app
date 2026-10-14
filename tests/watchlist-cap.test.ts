/**
 * The per-user watchlist cap, end to end through the Telegram /追蹤 command —
 * the entry point any stranger on Telegram can reach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const count  = vi.fn()
const create = vi.fn()
const tgSends: string[] = []

vi.mock("../src/db.js", () => ({
  db: {
    watchlist: {
      count:     (...a: unknown[]) => count(...a),
      create:    (...a: unknown[]) => create(...a),
      findFirst: async () => null,
      findMany:  async () => [],
    },
  },
}))
vi.mock("../src/services/ai.js", () => ({ hasAnyProviderKey: () => false, chatWithContext: async () => "" }))
vi.mock("../src/services/bot-context.js", () => ({ getUserContext: async () => ({}) }))
vi.mock("../src/adapters/index.js", () => ({
  getAdapter: () => ({ adapter: { validateSymbol: async () => true }, normalizedSymbol: "2330.TW" }),
}))
vi.mock("../src/utils/symbol.js", () => ({
  resolveSymbol: async () => ({ resolved: true, symbol: "2330.TW", assetType: "stock" }),
}))

import { handleTelegramWebhook } from "../src/webhooks/telegram.js"
import { MAX_WATCHLIST_PER_USER } from "../src/utils/watchlist-cap.js"

/** Minimal Hono-context stand-in: the handler reads the JSON body, one header, and replies with c.json. */
function ctx(text: string) {
  const body = { message: { text, chat: { id: 4242 }, from: { id: 4242 } } }
  return {
    req: { header: () => undefined, json: async () => body },
    json: (v: unknown, status = 200) => new Response(JSON.stringify(v), { status }),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  tgSends.length = 0
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test")
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "")
  vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
    tgSends.push(JSON.parse(init.body).text)
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("watchlist cap via /追蹤", () => {
  it("adds below the cap", async () => {
    count.mockResolvedValue(MAX_WATCHLIST_PER_USER - 1)
    await handleTelegramWebhook(ctx("/追蹤 2330"))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("refuses at the cap, says why, and writes nothing", async () => {
    count.mockResolvedValue(MAX_WATCHLIST_PER_USER)
    await handleTelegramWebhook(ctx("/追蹤 2330"))
    expect(create).not.toHaveBeenCalled()
    expect(tgSends[0]).toContain(`上限 ${MAX_WATCHLIST_PER_USER}`)
  })

  it("counts this user's rows on Telegram, not everyone's", async () => {
    count.mockResolvedValue(0)
    await handleTelegramWebhook(ctx("/追蹤 2330"))
    expect(count.mock.calls[0][0]).toEqual({ where: { user_id: "4242", platform: "telegram" } })
  })
})
