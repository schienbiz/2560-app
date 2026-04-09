import { Hono } from "hono"
import { serveStatic } from "@hono/node-server/serve-static"
import { chartRouter }     from "./routes/chart.js"
import { watchlistRouter } from "./routes/watchlist.js"
import { tradesRouter }    from "./routes/trades.js"
import { remindersRouter } from "./routes/reminders.js"
import { scanRouter }      from "./routes/scan.js"

const app = new Hono()

// ─── API ─────────────────────────────────────────────────────────────────────
app.route("/api",           chartRouter)
app.route("/api/watchlist", watchlistRouter)
app.route("/api/trades",    tradesRouter)
app.route("/api/reminders", remindersRouter)
app.route("/api/scan",      scanRouter)

// ─── Internal cron endpoints (guarded by INTERNAL_SECRET header) ─────────────
app.post("/internal/scan", async c => {
  const secret = c.req.header("x-internal-secret")
  if (secret !== process.env.INTERNAL_SECRET) return c.json({ error: "Forbidden" }, 403)
  const { runScan } = await import("../cron/scan.js")
  await runScan()
  return c.json({ ok: true })
})

app.post("/internal/remind", async c => {
  const secret = c.req.header("x-internal-secret")
  if (secret !== process.env.INTERNAL_SECRET) return c.json({ error: "Forbidden" }, 403)
  const { runRemind } = await import("../cron/remind.js")
  await runRemind()
  return c.json({ ok: true })
})

// ─── Frontend config (injects env vars as JS globals) ────────────────────────
app.get("/config.js", c => {
  const liffId = process.env.LIFF_ID ?? ""
  c.header("Content-Type", "application/javascript")
  c.header("Cache-Control", "no-cache")
  return c.body(`window.__LIFF_ID__ = "${liffId}";`)
})

// ─── Static frontend ─────────────────────────────────────────────────────────
app.use("/*", serveStatic({ root: "./public" }))

export default app
