/**
 * Shared AI service — Groq free tier (Llama 3.1 8B).
 *
 * Free tier: 30 RPM, 14,400 req/day — plenty for a small trading app.
 * Get API key: console.groq.com → API Keys → Create
 * No credit card required.
 *
 * Two entry points:
 *   analyzeChart(data, question?) → chart-specific commentary
 *   chatWithContext(question, ctx) → general bot chat with user's data
 */

import type { ChartData } from "../engine/types.js"

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
const MODEL    = "llama-3.1-8b-instant"

const SYSTEM = `你是 2560戰法的交易助理。2560戰法是一套以 MA25（25日均線）和 MA60（60日均線）交叉為核心的趨勢策略：
- 黃金交叉（MA25 由下往上穿越 MA60）= 買入訊號
- 死亡交叉（MA25 由上往下穿越 MA60）= 賣出訊號
- 理想進場區：MA25 附近（±1%），趨勢剛確立時的低風險區域
- 策略停損：MA60，多方格局的支撐下限

回覆使用繁體中文，語氣直接、具體、簡短（3-5句）。不過度使用術語，讓一般投資人能理解。`

async function chat(userMsg: string): Promise<string> {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error("GROQ_API_KEY not set")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)

  const res = await fetch(GROQ_URL, {
    method:  "POST",
    signal:  controller.signal,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user",   content: userMsg },
      ],
    }),
  })
  clearTimeout(timeout)

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq error ${res.status}: ${err}`)
  }

  const data = await res.json() as { choices: { message: { content: string } }[] }
  return data.choices[0]?.message?.content ?? "無法生成回覆。"
}

// ─── Chart analysis ───────────────────────────────────────────────────────────

export async function analyzeChart(data: ChartData, question?: string): Promise<string> {
  const lastBar = data.ohlcv.at(-1)
  if (!lastBar) return "資料不足，無法分析。"

  const close = lastBar.close
  const ma25  = [...data.ma25].reverse().find(v => v != null) ?? null
  const ma60  = [...data.ma60].reverse().find(v => v != null) ?? null

  const pct = (a: number, b: number) => {
    const v = (a - b) / b * 100
    return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`
  }

  const signalLabel =
    data.signal === "golden_cross" ? "黃金交叉" :
    data.signal === "death_cross"  ? "死亡交叉" : "無明顯交叉訊號"

  const context = [
    `標的：${data.symbol}（${data.asset_type === "stock" ? "台股" : "加密貨幣"}）`,
    `最新收盤：${close.toLocaleString()}`,
    `MA25：${ma25 != null ? ma25.toFixed(2) : "N/A"}${ma25 != null ? `（價格距 MA25：${pct(close, ma25)}）` : ""}`,
    `MA60：${ma60 != null ? ma60.toFixed(2) : "N/A"}${(ma25 != null && ma60 != null) ? `（MA25 距 MA60：${pct(ma25, ma60)}）` : ""}`,
    `目前訊號：${signalLabel}，信心度：${data.confidence === "high" ? "高" : data.confidence === "medium" ? "中" : "低"}`,
    data.signal_date    ? `訊號觸發：${data.signal_date}` : "",
    data.support.length    ? `支撐：${data.support.map(v => v.toLocaleString()).join("、")}` : "",
    data.resistance.length ? `壓力：${data.resistance.map(v => v.toLocaleString()).join("、")}` : "",
  ].filter(Boolean).join("\n")

  const userMsg = question
    ? `${context}\n\n用戶問題：${question}`
    : `${context}\n\n請根據以上資料，給出簡短的進退場分析建議。`

  return chat(userMsg)
}

// ─── General bot chat ─────────────────────────────────────────────────────────

export interface BotContext {
  watchlist?:    { symbol: string; signal?: string }[]
  recentTrades?: { symbol: string; direction: string; entry_price: number; exit_price?: number | null }[]
}

export async function chatWithContext(question: string, ctx: BotContext): Promise<string> {
  const watchlistStr = ctx.watchlist?.length
    ? `自選清單：${ctx.watchlist.map(w => `${w.symbol}（${w.signal ?? "無訊號"}）`).join("、")}`
    : "自選清單：（無）"

  const tradesStr = ctx.recentTrades?.length
    ? `最近交易：\n${ctx.recentTrades.slice(0, 5).map(t => {
        const pnl = t.exit_price != null
          ? ((t.exit_price - t.entry_price) / t.entry_price * 100).toFixed(1) + "%"
          : "持倉中"
        return `  ${t.symbol} ${t.direction === "long" ? "做多" : "做空"} 進場 ${t.entry_price} → ${pnl}`
      }).join("\n")}`
    : "最近交易：（無）"

  return chat(`${watchlistStr}\n${tradesStr}\n\n問題：${question}`)
}
