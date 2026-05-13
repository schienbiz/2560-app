/**
 * Shared AI service — NVIDIA NIM primary, Groq fallback.
 *
 * Primary:  NVIDIA NIM  (meta/llama-3.1-70b-instruct) — better quality
 * Fallback: Groq        (llama-3.1-8b-instant)         — kicks in if NVIDIA fails/times out
 *
 * Set NVIDIA_API_KEY in .env to enable the primary.
 * Set GROQ_API_KEY   in .env to enable the fallback.
 * At least one must be present; having both gives full redundancy.
 *
 * Two entry points:
 *   analyzeChart(data, question?) → structured 5-point price action analysis
 *   chatWithContext(question, ctx) → general bot chat with user's data
 */

import type { ChartData } from "../engine/types.js"
import { computeStructure } from "../engine/structure.js"

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
const NVIDIA_MODEL = "meta/llama-3.1-70b-instruct"

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
const GROQ_MODEL = "llama-3.1-8b-instant"

const SYSTEM = `你是 2560戰法的交易助理。2560戰法是一套以 MA25（25日均線）和 MA60（60日均線）交叉為核心的趨勢策略：
- 黃金交叉（MA25 由下往上穿越 MA60）= 買入訊號
- 死亡交叉（MA25 由上往下穿越 MA60）= 賣出訊號
- 理想進場區：MA25 附近（±1%），趨勢剛確立時的低風險區域
- 策略停損 / 偏向失效：收盤跌破 MA60

回覆使用繁體中文，語氣直接、具體。`

// ─── Single provider call (OpenAI-compatible) ─────────────────────────────────

async function callProvider(url: string, key: string, model: string, userMsg: string): Promise<string> {
  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 30_000)

  const res = await fetch(url, {
    method:  "POST",
    signal:  controller.signal,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user",   content: userMsg },
      ],
    }),
  })
  clearTimeout(timeout)

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`${url.includes("nvidia") ? "NVIDIA" : "Groq"} error ${res.status}: ${err}`)
  }

  const data = await res.json() as { choices: { message: { content: string } }[] }
  return data.choices[0]?.message?.content ?? "無法生成回覆。"
}

// ─── Chat: NVIDIA primary → Groq fallback ────────────────────────────────────

async function chat(userMsg: string): Promise<string> {
  const nvidiaKey = process.env.NVIDIA_API_KEY
  const groqKey   = process.env.GROQ_API_KEY

  if (!nvidiaKey && !groqKey) throw new Error("未設定 AI API 金鑰（NVIDIA_API_KEY 或 GROQ_API_KEY）")

  if (nvidiaKey) {
    try {
      return await callProvider(NVIDIA_URL, nvidiaKey, NVIDIA_MODEL, userMsg)
    } catch (err) {
      console.warn("[ai] NVIDIA failed, falling back to Groq:", (err as Error).message)
      if (!groqKey) throw err
    }
  }

  return callProvider(GROQ_URL, groqKey!, GROQ_MODEL, userMsg)
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function pctDiff(a: number, b: number): string {
  const v = (a - b) / b * 100
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "impulse_up":   return "趨勢推進（多方）"
    case "impulse_down": return "趨勢推進（空方）"
    case "correction":   return "回調修正"
    case "range":        return "盤整"
    default:             return phase
  }
}

// ─── Chart analysis ───────────────────────────────────────────────────────────

export async function analyzeChart(data: ChartData, question?: string): Promise<string> {
  const lastBar = data.ohlcv.at(-1)
  if (!lastBar) return "資料不足，無法分析。"

  const close = lastBar.close
  const ma25  = [...data.ma25].reverse().find(v => v != null) ?? null
  const ma60  = [...data.ma60].reverse().find(v => v != null) ?? null

  // Compute price action structure (swing points, trend phase, ATR)
  const struct = computeStructure(data.ohlcv, data.ma25, data.ma60)

  // Recent 15 candles as a compact table so the model can reason about price action
  const candleTable = data.ohlcv.slice(-15)
    .map(b => `  ${b.date}: H=${fmt(b.high)} L=${fmt(b.low)} C=${fmt(b.close)}`)
    .join("\n")

  // Swing structure string
  const swingStr = struct.swings.length > 0
    ? struct.swings.map(s => `${s.label}@${fmt(s.price)}(${s.date})`).join(" → ")
    : "（樞紐點資料不足）"

  // Entry zone: MA25 ± 1%
  const entryZone = ma25 != null
    ? `${fmt(ma25 * 0.99)}–${fmt(ma25 * 1.01)}`
    : "N/A"

  // ATR as % of price
  const atrPct = close > 0 ? (struct.atr14 / close * 100).toFixed(1) : "N/A"

  // Signal label with confidence
  const signalLabel =
    data.signal === "golden_cross"
      ? `黃金交叉（${data.signal_date ?? "近期"}，信心度：${data.confidence === "high" ? "高" : data.confidence === "medium" ? "中" : "低"}）`
    : data.signal === "death_cross"
      ? `死亡交叉（${data.signal_date ?? "近期"}，信心度：${data.confidence === "high" ? "高" : data.confidence === "medium" ? "中" : "低"}）`
    : "無明顯交叉訊號"

  const context = [
    `標的：${data.symbol}（${data.asset_type === "stock" ? "台股" : "加密貨幣"}）`,
    `最新收盤：${fmt(close)}`,
    `MA25：${ma25 != null ? fmt(ma25) : "N/A"}（收盤距 MA25：${ma25 != null ? pctDiff(close, ma25) : "N/A"}）`,
    `MA60：${ma60 != null ? fmt(ma60) : "N/A"}（MA25 距 MA60：${(ma25 != null && ma60 != null) ? pctDiff(ma25, ma60) : "N/A"}）`,
    `2560訊號：${signalLabel}`,
    ``,
    `近15日K線（日期 H/L/C）：`,
    candleTable,
    ``,
    `日線擺動結構：${swingStr}`,
    `趨勢階段：${phaseLabel(struct.phase)}`,
    `偏向：${struct.bias === "bullish" ? "看多" : struct.bias === "bearish" ? "看空" : "中性"}`,
    `ATR(14)：${fmt(struct.atr14)}（每日波動約 ${atrPct}%）`,
    ``,
    data.support.length    ? `支撐區：${data.support.map(v => fmt(v)).join("、")}` : "",
    data.resistance.length ? `壓力區：${data.resistance.map(v => fmt(v)).join("、")}` : "",
    `進場區（MA25 ±1%）：${entryZone}`,
    `偏向失效線（MA60）：${ma60 != null ? fmt(ma60) : "N/A"}`,
  ].filter(Boolean).join("\n")

  const task = question
    ? `用戶問題：${question}\n\n基於以上資料回答問題，並補充以下五點分析：`
    : "基於以上資料，請給出以下五點結構化分析："

  const prompt = `${context}

${task}

1) 趨勢階段：impulse（推進）、correction（回調）還是 range（盤整）？說明 MA25/MA60 排列。
2) 價格結構：從擺動點描述 HH/HL 或 LH/LL 結構，判斷多空誰在控盤。
3) 進場區與操作：依 2560戰法，進場區（MA25 ±1%）、入場條件、多方/空方/觀望。
4) 偏向與理由：看多/看空/觀望，一句話核心理由（訊號 + 結構 + MA排列）。
5) 失效條件：具體說明哪個收盤價位會使此偏向失效。

每點 1–2 句，嚴格依照五點編號，簡潔有力。`

  return chat(prompt)
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
