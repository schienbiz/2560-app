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

async function verifyLine(token: string): Promise<string | null> {
  const channelId = process.env.LINE_CHANNEL_ID
  if (!channelId) return null

  try {
    const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `id_token=${encodeURIComponent(token)}&client_id=${channelId}`,
    })
    if (!res.ok) return null
    const data = await res.json() as { sub?: string }
    return data.sub ?? null
  } catch {
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
    if (!authDate || Math.floor(Date.now() / 1000) - authDate > 5 * 60) return null

    const user = JSON.parse(params.get("user") ?? "{}") as { id?: number }
    return user.id ? String(user.id) : null
  } catch {
    return null
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function authMiddleware(c: Context, next: Next) {
  const authorization = c.req.header("Authorization") ?? ""

  // Dev bypass — only in non-production environments.
  // Uses platform "line" so the DB enum constraint is satisfied.
  if (process.env.NODE_ENV !== "production" && authorization === "Bearer dev") {
    c.set("user", { userId: "dev-user", platform: "line" })
    return next()
  }

  if (authorization.startsWith("Bearer ")) {
    const token = authorization.slice(7)
    const userId = await verifyLine(token)
    if (userId) {
      c.set("user", { userId, platform: "line" })
      return next()
    }
  }

  if (authorization.startsWith("TG ")) {
    const initData = authorization.slice(3)
    const userId = verifyTelegram(initData)
    if (userId) {
      c.set("user", { userId, platform: "telegram" })
      return next()
    }
  }

  return c.json({ error: "Unauthorized" }, 401)
}
