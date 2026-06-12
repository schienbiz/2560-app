/**
 * Platform auth middleware for LINE and Telegram Mini Apps.
 *
 * LINE:     Authorization: Bearer {liff_id_token}
 *           Verified via LINE's token verification endpoint.
 *
 * Telegram: Authorization: TG {initData}
 *           Verified via HMAC-SHA256 with the bot token as secret.
 */

import type { Context, Next } from "hono"
import { createHmac } from "crypto"

export interface AuthUser {
  userId:   string
  platform: "line" | "telegram"
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser
  }
}

// ─── LINE ────────────────────────────────────────────────────────────────────

// Cache verified LINE tokens for 1 hour to avoid hitting LINE's API on every request.
// Key: id_token  Value: { userId, expiresAt }
const lineTokenCache = new Map<string, { userId: string; expiresAt: number }>()
const LINE_TOKEN_TTL = 60 * 60 * 1000  // 1 hour

// Purge expired entries every hour — prevents unbounded cache growth on long-running process
setInterval(() => {
  const now = Date.now()
  for (const [token, entry] of lineTokenCache) {
    if (now >= entry.expiresAt) lineTokenCache.delete(token)
  }
}, 60 * 60 * 1000)

async function verifyLine(token: string): Promise<string | null> {
  // LINE_CHANNEL_ID is the numeric prefix of LIFF_ID (e.g. "2009750300-3ibNysMP" → "2009750300")
  const channelId = process.env.LINE_CHANNEL_ID ?? process.env.LIFF_ID?.split("-")[0]
  if (!channelId) return null

  // Cache hit
  const cached = lineTokenCache.get(token)
  if (cached && Date.now() < cached.expiresAt) return cached.userId

  try {
    const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `id_token=${encodeURIComponent(token)}&client_id=${channelId}`,
    })
    if (!res.ok) return null
    const data = await res.json() as { sub?: string }
    if (!data.sub) return null

    lineTokenCache.set(token, { userId: data.sub, expiresAt: Date.now() + LINE_TOKEN_TTL })
    return data.sub
  } catch (err) {
    console.error("LINE token verify failed:", err)
    return null
  }
}

// ─── Telegram ────────────────────────────────────────────────────────────────

function verifyTelegram(initData: string): string | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!botToken) return null

  try {
    const params = new URLSearchParams(initData)
    const hash = params.get("hash")
    if (!hash) return null

    params.delete("hash")
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")

    const secret = createHmac("sha256", "WebAppData").update(botToken).digest()
    const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex")
    if (expected !== hash) return null

    const authDate = parseInt(params.get("auth_date") ?? "0", 10)
    if (!authDate || Math.floor(Date.now() / 1000) - authDate > 24 * 60 * 60) return null

    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number }
    return user.id ? String(user.id) : null
  } catch {
    return null
  }
}

// ─── Shared resolver (used by HTTP middleware + WS handler) ──────────────────

export async function resolveAuth(authorization: string): Promise<AuthUser | null> {
  if (process.env.NODE_ENV !== "production" && authorization === "Bearer dev") {
    return { userId: "dev-user", platform: "line" }
  }
  if (authorization.startsWith("Bearer ")) {
    const token = authorization.slice(7)
    const userId = await verifyLine(token)
    if (userId) return { userId, platform: "line" }
  }
  if (authorization.startsWith("TG ")) {
    const initData = authorization.slice(3)
    const userId = verifyTelegram(initData)
    if (userId) return { userId, platform: "telegram" }
  }
  return null
}

// ─── HTTP middleware ──────────────────────────────────────────────────────────

export async function authMiddleware(c: Context, next: Next) {
  const authorization = c.req.header("Authorization") ?? ""
  const user = await resolveAuth(authorization)
  if (!user) return c.json({ error: "Unauthorized" }, 401)
  c.set("user", user)
  return next()
}
