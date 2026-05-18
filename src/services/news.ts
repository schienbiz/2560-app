/**
 * Crypto market sentiment via Alternative.me Fear & Greed Index.
 *
 * fetchFearGreed()           → { value: 0-100, classification: string }
 * scoreFearGreed(fg, signal) → { score: -1|0|1, summary: string }
 *
 * No API key required. 1h in-memory cache. Global crypto market sentiment —
 * useful for all crypto assets.
 *
 * Fear + golden cross  = contrarian buy confirmation (score +1)
 * Greed + death cross  = distribution top confirmation (score +1)
 * Extreme divergence   = warning (score -1)
 */

export interface FearGreedData {
  value:              number   // 0 (Extreme Fear) – 100 (Extreme Greed)
  value_classification: string // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
}

export interface SentimentResult {
  score:   -1 | 0 | 1
  summary: string
}

let cache: { data: FearGreedData; expiresAt: number } | null = null
const CACHE_TTL = 60 * 60 * 1_000  // 1 hour

export async function fetchFearGreed(): Promise<FearGreedData | null> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.data

  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(6_000),
    })
    if (!res.ok) return null

    const json = await res.json() as { data?: { value: string; value_classification: string }[] }
    const row  = json.data?.[0]
    if (!row) return null

    const data: FearGreedData = {
      value:                parseInt(row.value, 10),
      value_classification: row.value_classification,
    }
    cache = { data, expiresAt: now + CACHE_TTL }
    return data
  } catch {
    return null
  }
}

/**
 * Map Fear & Greed value + signal direction to a sentiment score.
 *
 * Golden cross:
 *   Extreme Fear (0–24) or Fear (25–44) → +1  (contrarian confirmation — good entry)
 *   Neutral (45–55)                      →  0
 *   Greed (56–74)                        →  0  (risk of buying near top)
 *   Extreme Greed (75–100)               → -1  (overbought warning)
 *
 * Death cross:
 *   Extreme Greed (75–100) or Greed (56–74) → +1  (distribution top)
 *   Neutral (45–55)                          →  0
 *   Fear (25–44)                             →  0
 *   Extreme Fear (0–24)                      → -1  (oversold, reversal risk)
 */
export function scoreFearGreed(
  fg:     FearGreedData,
  signal: "golden_cross" | "death_cross"
): SentimentResult {
  const v = fg.value
  const label = `${fg.value_classification}（${v}）`

  if (signal === "golden_cross") {
    if (v <= 44) return { score:  1, summary: `市場恐懼，逢低佈局機會 ${label}` }
    if (v <= 55) return { score:  0, summary: `市場中性 ${label}` }
    if (v <= 74) return { score:  0, summary: `市場偏貪婪，注意風險 ${label}` }
    return              { score: -1, summary: `極度貪婪，買在高點風險高 ${label}` }
  } else {
    if (v >= 56) return { score:  1, summary: `市場貪婪，出貨訊號確認 ${label}` }
    if (v >= 45) return { score:  0, summary: `市場中性 ${label}` }
    if (v >= 25) return { score:  0, summary: `市場偏恐懼，反彈風險 ${label}` }
    return              { score: -1, summary: `極度恐懼，可能超賣反彈 ${label}` }
  }
}
