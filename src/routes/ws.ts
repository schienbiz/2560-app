/**
 * WebSocket handler — live price push for the user's watchlist.
 *
 * PROTOCOL:
 *   1. Client connects: GET /ws  (HTTP → WS upgrade)
 *   2. Client sends:    { type: "auth", token: "TG <initData>" | "Bearer <id_token>" }
 *   3. Server replies:  { type: "ready" }  then pushes every 10 s:
 *                       { type: "price", symbol, close, ma25, ma60, signal, confidence }
 *      close = live intraday price (TWSE real-time for TW stocks, Kraken ticker for crypto,
 *              Yahoo v7 quote for US stocks). Falls back to last OHLCV close when unavailable.
 *   4. On bad auth:     { type: "error", message: "Unauthorized" }  then closes.
 *
 * Registered in server.ts via WebSocketServer + http upgrade event.
 */

import type { WebSocket } from "ws"
import { resolveAuth, type AuthUser } from "../auth.js"
import { db } from "../db.js"
import { getAdapter } from "../adapters/index.js"
import { computeMA } from "../engine/index.js"
import { scoreSignal } from "../engine/signal.js"
import { getOrFetchOHLCV, fetchDaysFor } from "../utils/ohlcv.js"

const INTERVAL_MS = 10_000

type WsState = { user?: AuthUser; timer?: ReturnType<typeof setInterval> }
const state = new WeakMap<WebSocket, WsState>()

async function pushPrices(ws: WebSocket, user: AuthUser): Promise<void> {
  if (ws.readyState !== 1 /* OPEN */) return

  const watchlist = await db.watchlist.findMany({
    where: { user_id: user.userId, platform: user.platform },
    include: { alert: true },
    orderBy: { created_at: "asc" },
  })

  for (const item of watchlist) {
    try {
      const { adapter, normalizedSymbol } = getAdapter(item.symbol)
      const assetType = adapter.getAssetType()
      const fastPeriod = item.alert?.fast_period ?? 25
      const slowPeriod = item.alert?.slow_period ?? 60
      const days = fetchDaysFor(slowPeriod, assetType)

      const ohlcv  = await getOrFetchOHLCV(normalizedSymbol, assetType, days, adapter)
      const closes = ohlcv.map(b => b.close)
      const maFast = computeMA(closes, fastPeriod)
      const maSlow = computeMA(closes, slowPeriod)
      const result = scoreSignal(ohlcv, maFast, maSlow)
      const latest = ohlcv[ohlcv.length - 1]

      // Try live quote; fall back to last OHLCV close when unavailable (market closed, etc.)
      let liveClose = latest?.close ?? null
      if (adapter.fetchQuote) {
        const q = await adapter.fetchQuote(normalizedSymbol).catch(() => null)
        if (q !== null) liveClose = q
      }

      ws.send(JSON.stringify({
        type:        "price",
        symbol:      normalizedSymbol,
        close:       liveClose,
        ma25:        maFast[maFast.length - 1] ?? null,
        ma60:        maSlow[maSlow.length - 1] ?? null,
        fast_period: fastPeriod,
        slow_period: slowPeriod,
        signal:      result.signal,
        confidence:  result.confidence,
      }))
    } catch {
      // Skip failed symbols — don't kill the whole push cycle.
    }
  }
}

export function handleWsConnection(ws: WebSocket): void {
  state.set(ws, {})

  ws.on("message", async (data: Buffer | string) => {
    const s = state.get(ws)
    if (!s || s.user) return   // not tracked or already authenticated

    let msg: { type?: string; token?: string }
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.type !== "auth") return

    const user = await resolveAuth(msg.token ?? "")
    if (!user) {
      ws.send(JSON.stringify({ type: "error", message: "Unauthorized" }))
      ws.close()
      return
    }

    s.user = user
    ws.send(JSON.stringify({ type: "ready" }))
    await pushPrices(ws, user)
    s.timer = setInterval(() => pushPrices(ws, user), INTERVAL_MS)
  })

  ws.on("close", () => {
    const s = state.get(ws)
    if (s?.timer) clearInterval(s.timer)
    state.delete(ws)
  })

  ws.on("error", () => {
    const s = state.get(ws)
    if (s?.timer) clearInterval(s.timer)
    state.delete(ws)
  })
}
