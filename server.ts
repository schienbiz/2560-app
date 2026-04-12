import { serve } from "@hono/node-server"
import { WebSocketServer } from "ws"
import app from "./src/index.js"
import { handleWsConnection } from "./src/routes/ws.js"

const port = parseInt(process.env.PORT ?? "3000", 10)

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
