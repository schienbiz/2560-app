/**
 * Shared AI service — NVIDIA NIM → Groq → Cerebras → OpenRouter fallback chain.
 *
 * Priority:  NVIDIA NIM    (meta/llama-3.3-70b-instruct)        — best quality
 * Fallback1: Groq          (llama-3.3-70b-versatile)            — fast, free
 * Fallback2: Cerebras      (gpt-oss-120b)                       — ultra-fast
 * Fallback3: OpenRouter    (moonshotai/kimi-k2.6:free) — 262k ctx, strong trading language
 *
 * Set any combination in .env; at least one key must be present.
 * Each provider is tried in order; the first successful response wins.
 *
 * Two entry points:
 *   analyzeChart(data, question?) → structured multi-point price action analysis
 *   chatWithContext(question, ctx) → general bot chat with user's data
 */

import type { ChartData } from "../engine/types.js"
import { computeStructure } from "../engine/structure.js"

const NVIDIA_URL   = "https://integrate.api.nvidia.com/v1/chat/completions"
const NVIDIA_MODEL = "meta/llama-3.3-70b-instruct"

const GROQ_URL   = "https://api.groq.com/openai/v1/chat/completions"
const GROQ_MODEL = "llama-3.3-70b-versatile"

const CEREBRAS_URL   = "https://api.cerebras.ai/v1/chat/completions"
const CEREBRAS_MODEL = "gpt-oss-120b"

const OPENROUTER_URL   = "https://openrouter.ai/api/v1/chat/completions"
const OPENROUTER_MODEL = "moonshotai/kimi-k2.6:free"

const SYSTEM = `你是 2560戰法的交易助理。2560戰法是一套以 MA25（25日均線）和 MA60（60日均線）交叉為核心的趨勢策略：
- 黃金交叉（MA25 由下往上穿越 MA60）= 買入訊號
- 死亡交叉（MA25 由上往下穿越 MA60）= 賣出訊號
- 理想進場區：MA25 附近（±1%），趨勢剛確立時的低風險區域
- 策略停損 / 偏向失效：收盤跌破 MA60

回覆使用繁體中文，語氣直接、具體。`

// ─── Single provider call (OpenAI-compatible) ─────────────────────────────────

async function callProvider(
  label:   string,
  url:     string,
  key:     string,
  model:   string,
  userMsg: string,
  extraHeaders?: Record<string, string>
): Promise<string> {
  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 30_000)

  const res = await fetch(url, {
    method:  "POST",
    signal:  controller.signal,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${key}`,
      ...extraHeaders,
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
    throw new Error(`[${label}] error ${res.status}: ${err}`)
  }

  const data = await res.json() as { choices: { message: { content: string } }[] }
  return data.choices[0]?.message?.content ?? "無法生成回覆。"
}

// ─── Provider registry ────────────────────────────────────────────────────────

interface Provider {
  label:        string
  url:          string
  model:        string
  key:          () => string | undefined
  extraHeaders?: Record<string, string>
}

function getProviders(): Provider[] {
  return [
    {
      label: "NVIDIA", url: NVIDIA_URL, model: NVIDIA_MODEL,
      key: () => process.env.NVIDIA_API_KEY,
    },
    {
      label: "Groq", url: GROQ_URL, model: GROQ_MODEL,
      key: () => process.env.GROQ_API_KEY,
    },
    {
      label: "Cerebras", url: CEREBRAS_URL, model: CEREBRAS_MODEL,
      key: () => process.env.CEREBRAS_API_KEY,
    },
    {
      label: "OpenRouter", url: OPENROUTER_URL, model: OPENROUTER_MODEL,
      key: () => process.env.OPENROUTER_API_KEY,
      extraHeaders: {
        "HTTP-Referer": process.env.APP_URL ?? "https://two560-app.onrender.com",
        "X-Title":      "2560戰法",
      },
    },
  ].filter(p => !!p.key())
}

// ─── Chat: NVIDIA → Groq → OpenRouter sequential fallback ────────────────────
// Used for latency-sensitive calls (push notifications, sentiment scoring).

export async function chat(userMsg: string): Promise<string> {
  const providers = getProviders()
  if (providers.length === 0) throw new Error("未設定 AI API 金鑰（NVIDIA_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY）")

  for (const p of providers) {
    try {
      return await callProvider(p.label, p.url, p.key()!, p.model, userMsg, p.extraHeaders)
    } catch (err) {
      console.warn(`[ai] ${p.label} failed:`, (err as Error).message)
    }
  }
  throw new Error("[ai] 所有 AI 服務均失敗")
}

// ─── Multi-model synthesis: all providers in parallel → cross-validate ───────
// Used for on-demand analysis (analyzeChart, chatWithContext).
// Each available model answers independently; a synthesis pass reconciles
// agreements and flags divergences to produce a more accurate final answer.
// Gracefully degrades to single-model when only one key is configured.

export async function multiChat(userMsg: string): Promise<string> {
  const providers = getProviders()
  if (providers.length === 0) throw new Error("未設定 AI API 金鑰")
  if (providers.length === 1) {
    return callProvider(providers[0].label, providers[0].url, providers[0].key()!, providers[0].model, userMsg, providers[0].extraHeaders)
  }

  // Call all providers in parallel (30s per-provider timeout via AbortController)
  const results = await Promise.allSettled(
    providers.map(p => callProvider(p.label, p.url, p.key()!, p.model, userMsg, p.extraHeaders))
  )

  const ok = results
    .map((r, i) => r.status === "fulfilled" ? { label: providers[i].label, text: r.value } : null)
    .filter((r): r is { label: string; text: string } => r !== null)

  console.log(`[ai] multi: ${ok.map(r => r.label).join("+")} responded`)

  if (ok.length === 0) throw new Error("[ai] 所有 AI 服務均失敗")
  if (ok.length === 1) return ok[0].text

  // Synthesis prompt: find consensus, flag divergences, produce a better answer
  const perspectives = ok.map(r => `【${r.label}】\n${r.text}`).join("\n\n---\n\n")

  const synthPrompt = `以下是 ${ok.length} 個 AI 模型對同一交易問題的獨立分析：

${perspectives}

---

任務：交叉比對以上分析，輸出一份更精準的最終版本。
規則：
1. 多數模型一致的判斷 → 直接採用為結論
2. 有分歧的判斷 → 選擇有具體數據支撐的一方，並在該點加上「⚠ 分析有分歧：」說明
3. 只輸出最終分析，不要重複列出各模型原文
4. 保持繁體中文、直接具體的風格，格式與原問題要求一致`

  try {
    // Synthesize with the first successful provider
    const synth = providers.find(p => ok.find(r => r.label === p.label))!
    const final = await callProvider(
      `${synth.label}(synthesis)`, synth.url, synth.key()!, synth.model, synthPrompt, synth.extraHeaders
    )
    console.log(`[ai] synthesis via ${synth.label}`)
    return final
  } catch (err) {
    console.warn("[ai] synthesis failed, returning best single response:", (err as Error).message)
    return ok[0].text
  }
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

  const rsiLabel  = data.rsi != null
    ? `RSI(14)：${data.rsi.toFixed(1)}（${data.rsi >= 70 ? "超買" : data.rsi <= 30 ? "超賣" : data.rsi > 50 ? "偏多" : "偏空"}）`
    : ""
  const macdLabel = data.macdHist != null
    ? `MACD柱狀(12/26/9)：${data.macdHist >= 0 ? "+" : ""}${data.macdHist.toFixed(4)}（${data.macdHist >= 0 ? "多頭動能" : "空頭動能"}）`
    : ""

  const context = [
    `標的：${data.symbol}（${data.asset_type === "stock" ? "台股" : "加密貨幣"}）`,
    `最新收盤：${fmt(close)}`,
    `MA25：${ma25 != null ? fmt(ma25) : "N/A"}（收盤距 MA25：${ma25 != null ? pctDiff(close, ma25) : "N/A"}）`,
    `MA60：${ma60 != null ? fmt(ma60) : "N/A"}（MA25 距 MA60：${(ma25 != null && ma60 != null) ? pctDiff(ma25, ma60) : "N/A"}）`,
    rsiLabel,
    macdLabel,
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
3) 動能確認：RSI 與 MACD 柱狀是否與訊號方向一致？說明超買/超賣風險。
4) 進場區與操作：依 2560戰法，進場區（MA25 ±1%）、入場條件、多方/空方/觀望。
5) 偏向與理由：看多/看空/觀望，一句話核心理由（訊號 + RSI/MACD + MA排列）。
6) 失效條件：具體說明哪個收盤價位會使此偏向失效。

每點 1–2 句，嚴格依照五點編號，簡潔有力。`

  return multiChat(prompt)
}

// ─── Notification insight (1 sentence, optimised for LINE/Telegram push) ─────
//
// Returns a single punchy sentence of context for a cross or proximity alert.
// The caller constructs the structured header/data lines; this adds the "why
// this matters right now" layer that only AI can provide.

export interface SentimentCtx {
  score:   -1 | 0 | 1
  summary: string
}

export async function notifyInsight(
  data:        ChartData,
  signal:      string,
  fastPeriod:  number,
  slowPeriod:  number,
  sentiment?:  SentimentCtx
): Promise<string> {
  const lastBar = data.ohlcv.at(-1)
  if (!lastBar) return ""

  const close  = lastBar.close
  const ma25   = [...data.ma25].reverse().find(v => v != null) ?? null
  const ma60   = [...data.ma60].reverse().find(v => v != null) ?? null
  const struct = computeStructure(data.ohlcv, data.ma25, data.ma60)

  const signalCtx = signal === "golden_cross"
    ? `MA${fastPeriod} 剛由下往上穿越 MA${slowPeriod}（黃金交叉），信心度：${data.confidence === "high" ? "高（成交量放大）" : "普通"}`
    : signal === "death_cross"
    ? `MA${fastPeriod} 剛由上往下穿越 MA${slowPeriod}（死亡交叉），信心度：${data.confidence === "high" ? "高（成交量放大）" : "普通"}`
    : `價格接近 MA${fastPeriod}（${data.confidence === "high" ? "高信心度" : "普通"}）`

  const rsiLine  = data.rsi != null      ? `RSI(14)：${data.rsi.toFixed(1)}`                                     : ""
  const macdLine = data.macdHist != null ? `MACD柱：${data.macdHist >= 0 ? "+" : ""}${data.macdHist.toFixed(4)}` : ""
  const sentLine = sentiment
    ? `新聞情緒：${sentiment.score === 1 ? "正面" : sentiment.score === -1 ? "負面" : "中性"}（${sentiment.summary}）`
    : ""
  const indicators = [rsiLine, macdLine, sentLine].filter(Boolean).join("，")

  const prompt = `標的：${data.symbol}
收盤：${close}，MA${fastPeriod}：${ma25?.toFixed(2) ?? "N/A"}，MA${slowPeriod}：${ma60?.toFixed(2) ?? "N/A"}
訊號：${signalCtx}
趨勢階段：${struct.phase}，偏向：${struct.bias}，ATR(14)：${struct.atr14.toFixed(2)}${indicators ? "\n" + indicators : ""}

用一句繁體中文說明此訊號的操作意義（直接說結論，不要前綴詞如「建議」「根據」，不要標號，不要超過30字）。`

  try {
    const raw = await chat(prompt)
    return raw.replace(/^[\d\.\s]+/, "").replace(/^(建議|根據|由於|因此|總結)[，：:、]?/, "").trim()
  } catch {
    return ""
  }
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

  return multiChat(`${watchlistStr}\n${tradesStr}\n\n問題：${question}`)
}
