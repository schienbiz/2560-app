import { Hono } from "hono"
import { readFileSync } from "node:fs"
import { timingSafeEqual } from "node:crypto"
import { serveStatic } from "@hono/node-server/serve-static"
import { chartRouter }     from "./routes/chart.js"
import { watchlistRouter } from "./routes/watchlist.js"
import { tradesRouter }    from "./routes/trades.js"
import { remindersRouter } from "./routes/reminders.js"
import { scanRouter }      from "./routes/scan.js"
import { aiRouter }        from "./routes/ai.js"
import { signalsRouter }   from "./routes/signals.js"
import { backtestRouter }  from "./routes/backtest.js"
import { handleLineWebhook }     from "./webhooks/line.js"
import { handleTelegramWebhook } from "./webhooks/telegram.js"
import { pulseRouter }           from "./routes/pulse.js"

// Build stamp so a deploy is verifiable from outside: /health reports the
// package version and the running commit. Render injects RENDER_GIT_COMMIT
// automatically; falls back to a local git-less "dev".
const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
})()
const GIT_SHA: string = (process.env.RENDER_GIT_COMMIT ?? process.env.GIT_SHA ?? "dev").slice(0, 7)

const app = new Hono()

app.onError((err, c) => {
  console.error("Unhandled error:", err)
  return c.json({ error: "Internal server error" }, 500)
})

app.get("/health", c => c.json({ ok: true, service: "2560-app", version: VERSION, sha: GIT_SHA }))

// ─── API ─────────────────────────────────────────────────────────────────────
app.route("/api",           chartRouter)
app.route("/api/watchlist", watchlistRouter)
app.route("/api/trades",    tradesRouter)
app.route("/api/reminders", remindersRouter)
app.route("/api/scan",      scanRouter)
app.route("/api/ai",        aiRouter)
app.route("/api/signals",   signalsRouter)
app.route("/api/backtest",  backtestRouter)

// ─── Bot webhooks ─────────────────────────────────────────────────────────────
app.post("/webhook/line",     c => handleLineWebhook(c))
app.post("/webhook/telegram", c => handleTelegramWebhook(c))

// Constant-time secret comparison — avoids a timing side-channel on the internal-cron guard.
function secretMatches(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ─── Internal cron endpoints (guarded by INTERNAL_SECRET header) ─────────────
app.post("/internal/scan", async c => {
  const secret = c.req.header("x-internal-secret")
  if (!secretMatches(secret, process.env.INTERNAL_SECRET)) {
    return c.json({ error: "Forbidden" }, 403)
  }
  const marketParam = c.req.query("market")
  const markets = marketParam ? (marketParam.split(",") as Array<"tw" | "us" | "crypto">) : undefined
  const { runScan } = await import("../cron/scan.js")
  await runScan(markets)
  return c.json({ ok: true })
})

app.post("/internal/remind", async c => {
  const secret = c.req.header("x-internal-secret")
  if (!secretMatches(secret, process.env.INTERNAL_SECRET)) {
    return c.json({ error: "Forbidden" }, 403)
  }
  const marketParam = c.req.query("market")
  const markets = marketParam ? (marketParam.split(",") as Array<"tw" | "us" | "crypto">) : undefined
  const { runRemind } = await import("../cron/remind.js")
  await runRemind(markets)
  return c.json({ ok: true })
})

app.post("/internal/morning-summary", async c => {
  const secret = c.req.header("x-internal-secret")
  if (!secretMatches(secret, process.env.INTERNAL_SECRET)) {
    return c.json({ error: "Forbidden" }, 403)
  }
  const { runMorningSummary } = await import("../cron/morning-summary.js")
  runMorningSummary().catch(err => console.error("Morning summary error:", err))
  return c.json({ ok: true })
})

app.post("/internal/outcome", async c => {
  const secret = c.req.header("x-internal-secret")
  if (!secretMatches(secret, process.env.INTERNAL_SECRET)) {
    return c.json({ error: "Forbidden" }, 403)
  }
  const { runOutcome } = await import("../cron/outcome.js")
  runOutcome().catch(err => console.error("Outcome cron error:", err))
  return c.json({ ok: true })
})

// ─── Frontend config (injects env vars as JS globals) ────────────────────────
app.get("/config.js", c => {
  const liffId = process.env.LIFF_ID ?? ""
  c.header("Content-Type", "application/javascript")
  c.header("Cache-Control", "no-cache")
  return c.body(`window.__LIFF_ID__ = ${JSON.stringify(liffId)};`)
})

// ─── Public pages (no auth — must be BEFORE serveStatic catch-all) ───────────
app.route("/pulse", pulseRouter)

// ─── Static frontend ─────────────────────────────────────────────────────────
app.use("/*", serveStatic({ root: "./public" }))

export default app
