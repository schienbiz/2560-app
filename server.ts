import { serve } from "@hono/node-server"
import app from "./src/index.js"

const port = parseInt(process.env.PORT ?? "3000", 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`2560-app running on port ${port}`)
})
