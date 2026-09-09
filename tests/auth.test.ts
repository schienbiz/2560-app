/**
 * Platform auth — the gate in front of every user-scoped route.
 *
 * It had no test file. Two things here are worth pinning above all: the
 * `Bearer dev` backdoor must be unreachable in production, and the Telegram
 * initData HMAC must not accept a forged hash. The backdoor's identity,
 * `dev-user`, has been sitting in the production database with an active alert
 * since 2026-04-11 — the app shares ONE Neon instance, so a local dev session
 * writes straight into production data. That is what happens when the gate is
 * only *believed* to be closed.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { createHmac } from "node:crypto"
import { resolveAuth } from "../src/auth.js"

const BOT = "123456:test-bot-token"

/** Build a valid Telegram Mini App initData string for a given user id. */
function initData(userId: number, opts: { authDate?: number; tamper?: boolean } = {}) {
  const authDate = opts.authDate ?? Math.floor(Date.now() / 1000)
  const params = new URLSearchParams()
  params.set("auth_date", String(authDate))
  params.set("user", JSON.stringify({ id: userId, first_name: "T" }))

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
  const secret = createHmac("sha256", "WebAppData").update(BOT).digest()
  let hash = createHmac("sha256", secret).update(dataCheckString).digest("hex")
  if (opts.tamper) hash = hash.slice(0, -1) + (hash.at(-1) === "0" ? "1" : "0")

  params.set("hash", hash)
  return params.toString()
}

describe("resolveAuth — the dev backdoor", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("is CLOSED in production", async () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(await resolveAuth("Bearer dev")).toBeNull()
  })

  it("is open outside production, and yields the identity that leaked into prod data", async () => {
    vi.stubEnv("NODE_ENV", "development")
    expect(await resolveAuth("Bearer dev")).toEqual({ userId: "dev-user", platform: "line" })
  })

  /**
   * The dangerous shape: NODE_ENV unset. The check is `!== "production"`, so
   * anywhere it is missing the backdoor is WIDE OPEN.
   *
   * The live backend IS safe — but do not confirm that from the Render
   * dashboard. `GET /v1/services/:id/env-vars` reports NODE_ENV as absent on
   * two560-app-2, because that endpoint returns only user-defined variables
   * while Render injects NODE_ENV=production into a Node service at runtime.
   * Reading the dashboard alone gives exactly the wrong answer. The only
   * trustworthy check is behavioural: on 2026-09-09,
   * `curl -H 'Authorization: Bearer dev' .../api/watchlist` answered 401.
   * Pinned so the fail-open default stays a known characteristic rather than a
   * surprise on a future host that does not inject it.
   */
  it("is OPEN when NODE_ENV is unset — fail-open, by construction", async () => {
    vi.stubEnv("NODE_ENV", "")
    expect(await resolveAuth("Bearer dev")).not.toBeNull()
  })

  it("rejects an empty or unrecognised Authorization header", async () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(await resolveAuth("")).toBeNull()
    expect(await resolveAuth("Basic abc")).toBeNull()
    expect(await resolveAuth("bearer dev")).toBeNull()   // case-sensitive
  })
})

describe("resolveAuth — Telegram initData", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("TELEGRAM_BOT_TOKEN", BOT)
  })
  afterEach(() => vi.unstubAllEnvs())

  it("accepts a correctly signed payload and returns the user id", async () => {
    expect(await resolveAuth(`TG ${initData(700000001)}`))
      .toEqual({ userId: "700000001", platform: "telegram" })
  })

  it("rejects a tampered hash", async () => {
    expect(await resolveAuth(`TG ${initData(1, { tamper: true })}`)).toBeNull()
  })

  it("rejects a payload whose fields were edited after signing", async () => {
    // Same hash, different user — the forgery this HMAC exists to stop.
    const good = new URLSearchParams(initData(1))
    good.set("user", JSON.stringify({ id: 999, first_name: "T" }))
    expect(await resolveAuth(`TG ${good.toString()}`)).toBeNull()
  })

  it("rejects a hash of the wrong length instead of throwing", async () => {
    // timingSafeEqual throws on differing lengths, so the guard in front of it
    // is load-bearing: without it a short hash is a 500, not a 401.
    const p = new URLSearchParams(initData(1))
    p.set("hash", "abc")
    expect(await resolveAuth(`TG ${p.toString()}`)).toBeNull()
  })

  it("rejects initData with no hash at all", async () => {
    const p = new URLSearchParams(initData(1))
    p.delete("hash")
    expect(await resolveAuth(`TG ${p.toString()}`)).toBeNull()
  })

  it("rejects a payload older than 24 hours", async () => {
    const old = Math.floor(Date.now() / 1000) - 25 * 60 * 60
    expect(await resolveAuth(`TG ${initData(1, { authDate: old })}`)).toBeNull()
  })

  it("accepts one just inside the 24-hour window", async () => {
    const recent = Math.floor(Date.now() / 1000) - 23 * 60 * 60
    expect(await resolveAuth(`TG ${initData(1, { authDate: recent })}`)).not.toBeNull()
  })

  it("rejects everything when the bot token is not configured", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "")
    expect(await resolveAuth(`TG ${initData(1)}`)).toBeNull()
  })

  it("rejects garbage without throwing", async () => {
    expect(await resolveAuth("TG not-even-query-string")).toBeNull()
    expect(await resolveAuth("TG ")).toBeNull()
  })
})

describe("resolveAuth — LINE", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production")
    // Deliberately not a 10-digit number: a synthetic numeric channel id trips the
    // pre-push guard as pii.phone.e164 on every push, and a guard that cries wolf
    // gets ignored. auth.ts only interpolates this into the verify request body.
    vi.stubEnv("LINE_CHANNEL_ID", "test-channel-id")
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it("returns the verified `sub` as the user id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ sub: "Uffffffffffffffffffffffffffffffff" }),
    })))
    expect(await resolveAuth("Bearer some-id-token"))
      .toEqual({ userId: "Uffffffffffffffffffffffffffffffff", platform: "line" })
  })

  it("rejects when LINE says the token is bad", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    expect(await resolveAuth("Bearer bad-token")).toBeNull()
  })

  it("rejects when the response carries no `sub`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    expect(await resolveAuth("Bearer no-sub")).toBeNull()
  })

  it("rejects — rather than throws — when LINE is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down") }))
    expect(await resolveAuth("Bearer x")).toBeNull()
  })

  it("caches a verified token, so LINE is not called again for it", async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ sub: "Uaaa" }) }))
    vi.stubGlobal("fetch", f)
    const token = `tok-${Math.random()}`      // fresh, so the module cache is cold
    await resolveAuth(`Bearer ${token}`)
    await resolveAuth(`Bearer ${token}`)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("rejects when neither LINE_CHANNEL_ID nor LIFF_ID is configured", async () => {
    vi.stubEnv("LINE_CHANNEL_ID", "")
    vi.stubEnv("LIFF_ID", "")
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sub: "U1" }) })))
    expect(await resolveAuth("Bearer whatever")).toBeNull()
  })
})
