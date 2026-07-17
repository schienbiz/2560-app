import { serve } from "@hono/node-server"
import app from "./src/index.js"

const port = parseInt(process.env.PORT ?? "3000", 10)

// Register bot commands with Telegram (fire-and-forget on startup)
if (process.env.TELEGRAM_BOT_TOKEN) {
  fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      commands: [
        { command: "追蹤",  description: "加入自選清單並開啟通知，例：/追蹤 2330" },
        { command: "移除",  description: "移除自選清單標的，例：/移除 2330" },
        { command: "清單",  description: "查看目前追蹤的所有標的" },
        { command: "pulse", description: "📡 信號雷達 — 熱門追蹤標的" },
      ],
    }),
  }).catch(() => {/* non-critical */})
}

// No WebSocket: live prices are on-demand only (⚡ 掃描 → /api/scan). The old
// /ws push refreshed quotes every 10 s per connection — a standing poll against
// TWSE/Kraken/Yahoo the user never asked for. Unhandled upgrade requests from
// stale cached clients are closed by Node's default behavior.
serve({ fetch: app.fetch, port }, () => {
  console.log(`2560-app running on port ${port}`)
})
