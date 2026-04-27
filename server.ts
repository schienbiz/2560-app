import { serve } from "@hono/node-server"
import { WebSocketServer } from "ws"
import app from "./src/index.js"
import { handleWsConnection } from "./src/routes/ws.js"

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

// Start the HTTP server first — serve() returns the underlying http.Server.
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`2560-app running on port ${port}`)
})

// Attach a WebSocket server to the same port via the HTTP upgrade event.
// noServer: true means ws doesn't bind its own port — we handle the upgrade.
const wss = new WebSocketServer({ noServer: true })

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws") {
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws))
  } else {
    socket.destroy()
  }
})

wss.on("connection", handleWsConnection)
