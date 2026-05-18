/**
 * CryptoPanic news feed + LLM sentiment scoring.
 *
 * fetchCryptoNews(symbol)           → string[] of recent headlines (1h cache)
 * scoreNewsSentiment(headlines, signal) → { score: -1|0|1, summary }
 *
 * Requires CRYPTOPANIC_TOKEN in env. Returns empty/neutral if key is missing.
 * Only useful for crypto assets; callers should check asset_type before calling.
 */

import { chat } from "./ai.js"

interface CryptoPanicPost {
  title:        string
  published_at: string
}

interface CacheEntry {
  headlines: string[]
  expiresAt: number
}

const CACHE_TTL = 60 * 60 * 1_000  // 1 hour
const cache     = new Map<string, CacheEntry>()

// Strip common exchange suffixes so "XBT/USD" → "BTC", "ETH/USDT" → "ETH"
function toTicker(symbol: string): string {
  return symbol
    .replace(/\/.*$/, "")            // remove /USD, /USDT etc.
    .replace(/USDT?$/, "")           // trailing USDT / USD (no slash)
    .replace(/XBT/, "BTC")           // Kraken uses XBT
    .toUpperCase()
}

export async function fetchCryptoNews(symbol: string): Promise<string[]> {
  const token = process.env.CRYPTOPANIC_TOKEN
  if (!token) return []

  const ticker = toTicker(symbol)
  const now    = Date.now()
  const hit    = cache.get(ticker)
  if (hit && hit.expiresAt > now) return hit.headlines

  try {
    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${token}&currencies=${encodeURIComponent(ticker)}&filter=hot&public=true`
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return []

    const data   = await res.json() as { results?: CryptoPanicPost[] }
    const titles = (data.results ?? []).slice(0, 15).map(p => p.title)
    cache.set(ticker, { headlines: titles, expiresAt: now + CACHE_TTL })
    return titles
  } catch {
    return []
  }
}

export interface SentimentResult {
  score:   -1 | 0 | 1
  summary: string
}

/**
 * Score whether news headlines support or contradict the technical signal.
 * Returns score 1 (positive/confirming), 0 (neutral), or -1 (negative/contradicting).
 */
export async function scoreNewsSentiment(
  headlines: string[],
  signal:    "golden_cross" | "death_cross"
): Promise<SentimentResult> {
  if (!headlines.length) return { score: 0, summary: "無新聞" }

  const signalCtx = signal === "golden_cross" ? "黃金交叉（買入訊號）" : "死亡交叉（賣出訊號）"
  const headlineList = headlines.slice(0, 10).map((h, i) => `${i + 1}. ${h}`).join("\n")

  const prompt = `近期新聞標題：
${headlineList}

技術訊號：${signalCtx}

判斷新聞情緒是否支持此技術訊號，只回傳 JSON，格式如下（不要有任何說明）：
{"score":1,"summary":"多頭消息主導"}

score 只能是 1（正面/支持訊號）、0（中性）、-1（負面/與訊號相反）。
summary 15字以內，繁體中文。`

  try {
    const raw   = await chat(prompt)
    const match = raw.match(/\{[^}]+\}/)
    if (!match) return { score: 0, summary: "中性" }

    const parsed = JSON.parse(match[0]) as { score?: number; summary?: string }
    const score  = parsed.score === 1 ? 1 : parsed.score === -1 ? -1 : 0
    return { score, summary: (parsed.summary ?? "中性").slice(0, 20) }
  } catch {
    return { score: 0, summary: "評估失敗" }
  }
}
