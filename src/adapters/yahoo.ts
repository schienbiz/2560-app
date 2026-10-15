/**
 * Yahoo Finance unofficial adapter — no API key required.
 *
 * DATA FLOW:
 *   fetchOHLCV("2330.TW", 90)
 *     → GET https://query1.finance.yahoo.com/v8/finance/chart/2330.TW
 *         ?interval=1d&range=6mo
 *     → { chart: { result: [{ timestamp[], indicators: { quote: [{ open, high, low, close, volume }] } }] } }
 *     → normalize to OHLCV[]
 *
 *   fetchQuote("2330.TW")
 *     → Taiwan stocks: TWSE mis.twse.com.tw real-time API (same source as 台新/玉山 Securities)
 *       Falls back to the Yahoo v8 chart meta price when TWSE is unavailable.
 *     → US stocks: Yahoo v8 chart meta.regularMarketPrice. The old
 *       v7/finance/quote endpoint is crumb-gated and returns 401 Unauthorized
 *       for keyless callers, so it silently never produced a live quote — the
 *       v8 chart endpoint serves the same price without auth.
 *
 * Symbol formats:
 *   Taiwan stocks:  "2330.TW"
 *   US stocks:      "AAPL", "TSLA"
 *   HK stocks:      "0700.HK"
 */

import type { MarketAdapter } from "./interface.js"
import type { OHLCV } from "../engine/types.js"
import { fetchWithRetry } from "./http.js"

const BASE      = "https://query1.finance.yahoo.com/v8/finance/chart"
const TWSE_BASE = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"

/**
 * Pick a live price out of a TWSE mis snapshot.
 *
 * `z` (last trade) is "-" between trades, during the pre-open auction, and for
 * illiquid symbols — sometimes for minutes. Falling straight through to Yahoo
 * on "-" trades a real-time source for a delayed one, so degrade within the
 * snapshot first: last trade → previous trade (`pz`) → best bid (`b`, an
 * underscore-joined depth list; the head is the top of book).
 */
export function parseTwseSnapshot(
  msg: { z?: string; pz?: string; b?: string } | undefined
): number | null {
  if (!msg) return null
  for (const v of [msg.z, msg.pz, msg.b?.split("_")[0]]) {
    if (!v || v === "-" || v === "N/A") continue
    const price = parseFloat(v)
    if (!isNaN(price) && price > 0) return price
  }
  return null
}

/** Extract the live price from a v8 chart response's meta block. */
export function parseV8MetaPrice(json: YahooResponse): number | null {
  const price = json.chart?.result?.[0]?.meta?.regularMarketPrice
  return typeof price === "number" && price > 0 ? price : null
}

interface YahooQuoteArrays {
  open:   (number | null)[]
  high:   (number | null)[]
  low:    (number | null)[]
  close:  (number | null)[]
  volume: (number | null)[]
}

/**
 * Normalize Yahoo chart arrays into OHLCV bars.
 *
 * Yahoo returns per-field `null` on partial bars (halts, gaps, missing data).
 * The previous `close ?? 0` / `high ?? 0` normalization kept a bar whose close
 * was valid but whose high/low were null as `high=0, low=0` — which poisons
 * downstream math: sr.ts records a phantom pivot low at price 0, and
 * structure.ts's ATR sees a huge true range (|0 − prevClose|). Here we drop any
 * bar with no usable close, and backfill a missing or non-positive open/high/low
 * from the close (a doji bar), so high/low stay sane while the close series —
 * the only thing MAs read — is preserved.
 */
export function normalizeYahooBars(
  timestamp: number[],
  quote: YahooQuoteArrays,
  days: number,
  meta?: YahooChartMeta,
): OHLCV[] {
  const bars: OHLCV[] = []
  for (let i = 0; i < timestamp.length; i++) {
    const close = quote.close[i]
    if (close == null || close <= 0) {
      // Only the LAST bar may be recovered, and only when its session is provably
      // over — see settledLastBarFromMeta. Any other close-less bar stays dropped.
      if (i === timestamp.length - 1) {
        const recovered = settledLastBarFromMeta(timestamp[i], quote.open[i], meta)
        if (recovered) bars.push(recovered)
      }
      continue   // no usable close → unusable bar
    }
    const pos = (v: number | null | undefined) => (v != null && v > 0 ? v : close)
    bars.push({
      date:   new Date(timestamp[i] * 1000).toISOString().slice(0, 10),
      open:   pos(quote.open[i]),
      high:   pos(quote.high[i]),
      low:    pos(quote.low[i]),
      close,
      volume: quote.volume[i] ?? 0,
    })
  }
  return bars.slice(-days)
}

/**
 * Rebuild the last bar from `meta` when Yahoo reports its close as null AFTER the
 * session has ended.
 *
 * WHY. Measured 2026-10-14→15 (92 samples, DIS/SMCI/SPY, ranges 6mo and 1y): the
 * just-closed US session's bar carries its final close from ~20:00 UTC, then at
 * 00:08, 00:18 and 00:28 UTC every series returned that bar with close = null,
 * and from 00:38 the close was back. meta.regularMarketPrice held the final close
 * (108.99 for DIS, regularMarketTime 20:03Z) the whole time. Dropping the bar —
 * the old behaviour — handed scan-us the PREVIOUS session as newest: 10 of the 21
 * scan-us runs GitHub started after 00:00 UTC did exactly that, and two subscribed
 * death crosses (SMR 10-02, RDW 10-09) were never sent.
 *
 * WHEN IT FILLS — all must hold, otherwise null (the bar stays dropped):
 *   - a positive regularMarketPrice with its regularMarketTime and the exchange's
 *     gmtoffset;
 *   - regularMarketTime falls on the SAME exchange-local date as the bar, so the
 *     price is that session's — not yesterday's close sitting next to today's
 *     pre-open placeholder bar, which is the one this must never fill;
 *   - currentTradingPeriod has already rolled PAST the bar (its start is later):
 *     Yahoo itself says the session is over, so the price is a settled close, not
 *     a live tick. If Yahoo nulls the close before rolling, we decline and the
 *     scan's 2-bar lookback catches the cross on the next run instead.
 * The settled bars this produces are written permanently (bulkInsertOHLCV keeps
 * settled days), which is why the conditions are conservative.
 *
 * Fields: close = regularMarketPrice; high/low = regularMarketDayHigh/Low when they
 * bracket the close (they matched the bar exactly in the probe), else the close;
 * open from the quote array if present (meta has none), else the close; volume =
 * regularMarketVolume.
 */
export function settledLastBarFromMeta(
  barTs: number,
  rawOpen: number | null | undefined,
  meta: YahooChartMeta | undefined,
): OHLCV | null {
  if (!meta) return null
  const price = meta.regularMarketPrice
  const rmt   = meta.regularMarketTime
  const off   = meta.gmtoffset
  const next  = meta.currentTradingPeriod?.regular?.start
  if (typeof price !== "number" || !(price > 0)) return null
  if (typeof rmt !== "number" || typeof off !== "number" || typeof next !== "number") return null

  const exchangeDate = (t: number) => new Date((t + off) * 1000).toISOString().slice(0, 10)
  if (exchangeDate(rmt) !== exchangeDate(barTs)) return null   // a different session's price
  if (rmt < barTs) return null                                  // before this session opened
  if (!(next > barTs)) return null                              // Yahoo has not moved on: not settled

  const hi = meta.regularMarketDayHigh
  const lo = meta.regularMarketDayLow
  const bracket = typeof hi === "number" && typeof lo === "number" && lo > 0 && lo <= price && price <= hi
  return {
    date:   new Date(barTs * 1000).toISOString().slice(0, 10),
    open:   rawOpen != null && rawOpen > 0 ? rawOpen : price,
    high:   bracket ? hi! : price,
    low:    bracket ? lo! : price,
    close:  price,
    volume: typeof meta.regularMarketVolume === "number" && meta.regularMarketVolume >= 0 ? meta.regularMarketVolume : 0,
  }
}

function daysToRange(days: number): string {
  if (days <= 5)   return "5d"
  if (days <= 30)  return "1mo"
  if (days <= 90)  return "3mo"
  if (days <= 180) return "6mo"
  if (days <= 365) return "1y"
  return "2y"
}

export class YahooFinanceAdapter implements MarketAdapter {
  getAssetType() { return "stock" as const }
  getSource()    { return "yahoo" }

  async validateSymbol(symbol: string): Promise<boolean> {
    // Accept any symbol that looks reasonable (letters, digits, dots, hyphens)
    // Avoids an external API call that may be blocked or rate-limited on some hosting environments
    return /^[A-Z0-9.\-]{1,20}$/.test(symbol.toUpperCase())
  }

  /**
   * Does Yahoo actually serve daily bars for this exact symbol?
   *
   * Used by utils/symbol.ts to decide .TW vs .TWO before a symbol is persisted.
   * Cheap (range=5d) and never throws — an unreachable Yahoo answers "unknown"
   * (null), which the caller must distinguish from a definitive "no" (false),
   * or a network blip would canonicalise a TWSE stock as OTC.
   */
  async probe(symbol: string): Promise<boolean | null> {
    try {
      return (await this._tryFetch(symbol, 5)) !== null
    } catch {
      return null
    }
  }

  async fetchOHLCV(symbol: string, days: number): Promise<OHLCV[]> {
    // 4-digit Taiwan stock shorthand — try TWSE (.TW) then OTC (.TWO)
    if (/^\d{4}$/.test(symbol)) {
      for (const suffix of [".TW", ".TWO"]) {
        const bars = await this._tryFetch(symbol + suffix, days)
        if (bars) return bars
      }
      throw new Error(`No data for symbol: ${symbol}`)
    }

    const bars = await this._tryFetch(symbol, days)
    if (bars) return bars

    // Stored as .TW but actually OTC — try .TWO fallback (handles legacy DB entries)
    if (symbol.toUpperCase().endsWith(".TW")) {
      const twoData = await this._tryFetch(symbol.slice(0, -3) + ".TWO", days)
      if (twoData) return twoData
    }

    throw new Error(`No data for symbol: ${symbol}`)
  }

  async fetchQuote(symbol: string): Promise<number | null> {
    const upper = symbol.toUpperCase()

    // Taiwan stocks — primary source: TWSE mis.twse.com.tw (same data as 台新/玉山 Securities)
    const twCode =
      upper.endsWith(".TWO") ? upper.slice(0, -4)
      : upper.endsWith(".TW")  ? upper.slice(0, -3)
      : /^\d{4}$/.test(upper)  ? upper
      : null

    if (twCode) {
      // Route by suffix: ".TW" is TWSE-listed, ".TWO" is TPEX/OTC — probing the
      // other exchange is a guaranteed miss that used to cost a serial round
      // trip. Bare 4-digit shorthand probes both, in parallel (wall time = one
      // round trip instead of two).
      const exchanges =
        upper.endsWith(".TWO") ? ["otc" as const]
        : upper.endsWith(".TW") ? ["tse" as const]
        : ["tse" as const, "otc" as const]
      const twsePrice = await this._twseQuote(twCode, exchanges)
      if (twsePrice !== null) return twsePrice
      // TWSE unavailable (market closed or holiday) — fall through to Yahoo
    }

    // US stocks and TWSE fallback: Yahoo Finance v7 real-time quote
    return this._yahooQuote(symbol)
  }

  /** TWSE/TPEX real-time ticker — free, no auth, same source used by all TW brokerages */
  private async _twseQuote(code: string, exchanges: ("tse" | "otc")[]): Promise<number | null> {
    const probe = async (ex: "tse" | "otc"): Promise<number | null> => {
      try {
        const suffix = ex === "tse" ? ".tw" : ".two"
        const url = `${TWSE_BASE}?ex_ch=${ex}_${code}${suffix}&_=${Date.now()}`
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(4000),
        })
        if (!res.ok) return null
        const json = await res.json() as TwseResponse
        return parseTwseSnapshot(json.msgArray?.[0])
      } catch {
        return null   // timeout or network error
      }
    }
    // A symbol lists on exactly one exchange, so at most one probe returns a
    // price — first non-null wins, order doesn't matter.
    const prices = await Promise.all(exchanges.map(probe))
    return prices.find(p => p !== null) ?? null
  }

  /** Yahoo v8 chart meta price — live quote for US stocks, fallback for TW */
  private async _yahooQuote(symbol: string): Promise<number | null> {
    try {
      const url = `${BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) return null
      return parseV8MetaPrice(await res.json() as YahooResponse)
    } catch {
      return null
    }
  }

  /**
   * One symbol attempt. Returns null for "this symbol has no daily bars here"
   * and THROWS for "could not find out" (rate limit, gateway fault, network).
   *
   * The distinction is load-bearing. `fetchOHLCV` and `probe` both treat null
   * as a definitive miss and move on to the .TWO candidate; if a throttled
   * response also read as null, a TWSE symbol whose .TW request happened to be
   * rate-limited would resolve as OTC and be persisted under the wrong
   * exchange. Verified against live Yahoo: a wrong-exchange symbol answers 404
   * (2330.TWO, 5230.TW), but 8215.TWO answers HTTP 200 with an EMPTY bar
   * array — so "200" alone is not evidence of a listing, and the old code's
   * `if (bars) return bars` accepted that empty array as success (`[]` is
   * truthy) and never tried the other exchange.
   */
  private async _tryFetch(symbol: string, days: number): Promise<OHLCV[] | null> {
    const range = daysToRange(days)
    const url = `${BASE}/${encodeURIComponent(symbol)}?interval=1d&range=${range}`
    const res = await fetchWithRetry(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeoutMs: 8_000 })

    // 404 (and Yahoo's 400 for a malformed ticker) = definitive "not here".
    if (res.status === 404 || res.status === 400) return null
    if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status} ${symbol}`)

    const json = await res.json() as YahooResponse
    const result = json.chart?.result?.[0]
    if (!result) return null

    const timestamp = result.timestamp
    const quote     = result.indicators?.quote?.[0]
    if (!Array.isArray(timestamp) || !quote) return null

    const bars = normalizeYahooBars(timestamp, quote, days, result.meta)
    // Say when the meta fill was used, so its first real nights can be checked
    // against the close Yahoo publishes ~30 minutes later.
    const lastIdx = timestamp.length - 1
    if (lastIdx >= 0 && quote.close[lastIdx] == null && bars.length > 0 &&
        bars[bars.length - 1].date === new Date(timestamp[lastIdx] * 1000).toISOString().slice(0, 10)) {
      console.log(`[yahoo] ${symbol} ${bars[bars.length - 1].date} close was null — filled ${bars[bars.length - 1].close} from meta`)
    }
    return bars.length > 0 ? bars : null
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface TwseResponse {
  msgArray?: Array<{
    c?: string  // stock code
    z?: string  // current price ("-" when market closed)
    y?: string  // yesterday close
  }>
}

// `timestamp` / `indicators` are optional on purpose: Yahoo answers 200 with a
// result object carrying neither for a symbol it knows nothing about (observed
// on 8215.TWO). Typing them as required made the old destructuring look safe.
/** The parts of a v8 chart `meta` block the adapter reads. All optional: absent ⇒ unknown. */
export interface YahooChartMeta {
  regularMarketPrice?:   number
  /** Unix seconds of the regular-session trade that `regularMarketPrice` is. */
  regularMarketTime?:    number
  regularMarketDayHigh?: number
  regularMarketDayLow?:  number
  regularMarketVolume?:  number
  /** Exchange's current UTC offset in seconds (e.g. -14400 New York in summer). */
  gmtoffset?:            number
  /** The session Yahoo currently considers current — it rolls to the NEXT one after a close. */
  currentTradingPeriod?: { regular?: { start?: number; end?: number } }
}

export interface YahooResponse {
  chart: {
    result?: Array<{
      meta?: YahooChartMeta
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open:   (number | null)[]
          high:   (number | null)[]
          low:    (number | null)[]
          close:  (number | null)[]
          volume: (number | null)[]
        }>
      }
    }>
  }
}
