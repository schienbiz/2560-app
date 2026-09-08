/**
 * Canonical symbol resolution — the single place a user-typed symbol becomes
 * the string this system stores.
 *
 * WHY THIS EXISTS (production evidence, 2026-09-07):
 * `getAdapter()` is synchronous, so it could only upper-case the input. A bare
 * Taiwan code was persisted as typed ("2330") while YahooFinanceAdapter
 * resolved ".TW" internally at fetch time. The cache key, the Watchlist row and
 * the SignalHistory unique key therefore all used "2330" — a *different* key
 * from the "2330.TW" that another entry produced for the same stock. The result
 * in the live database:
 *   - OhlcvCache held "2330" (503 bars) AND "2330.TW" (503 bars) with all 503
 *     closes identical; likewise 5230/5230.TW, 1314/1314.TW, 0050/0050.TW.
 *   - SignalHistory recorded EVERY 2330 event twice (2026-09-07 golden cross,
 *     2026-09-03 golden cross, 2026-08-13 death cross, every proximity alert),
 *     so win-rate stats counted one stock as two.
 *   - One user held both "5230" and "5230.TW" in the same watchlist → two
 *     pushes for one cross.
 *
 * And the suffix that WAS stored could simply be wrong: probing Yahoo directly
 * shows 5230, 8937 and 3176 are OTC (.TWO; their .TW answers 404) even though
 * the watchlist held "5230.TW" and "8937.TW". The adapter's legacy .TW→.TWO
 * fallback rescued the fetch but left the wrong key on the row.
 *
 * So: resolve once, at the write boundary, against the actual data source.
 */

import { getAdapter } from "../adapters/index.js"
import type { AssetType } from "../engine/types.js"

const TW_BARE     = /^\d{4}$/
const TW_SUFFIXED = /^(\d{4})\.(TW|TWO)$/

/** Probe result: true = listed here, false = definitively not, null = unknown. */
export type ProbeFn = (symbol: string) => Promise<boolean | null>

export interface ResolvedSymbol {
  /** The canonical symbol to persist and to key caches/history on. */
  symbol:    string
  assetType: AssetType
  /**
   * False when a Taiwan code could not be pinned to an exchange (both probes
   * failed or were inconclusive). Callers that PERSIST must refuse rather than
   * store a guess — a wrong suffix is exactly what created the alias mess.
   */
  resolved:  boolean
}

/**
 * Pure suffix resolution for a 4-digit Taiwan code, given a probe.
 *
 * Tries TWSE (.TW) first — the large majority of codes — then TPEx (.TWO).
 * A null (inconclusive) probe is never treated as a "no": if .TW is unknown we
 * do NOT fall through and declare the stock OTC, because a rate-limited .TW
 * request would then permanently mislabel a TWSE listing.
 */
export async function resolveTwSuffix(
  code: string,
  probe: ProbeFn
): Promise<{ symbol: string; resolved: boolean }> {
  const tw = await probe(`${code}.TW`)
  if (tw === true) return { symbol: `${code}.TW`, resolved: true }

  // Inconclusive is NOT a "no". Falling through to .TWO here would let a
  // rate-limited or timed-out .TW request file a TWSE listing as OTC — and a
  // wrong suffix is permanent once it is written to a watchlist row, a cache
  // key and a signal-history key.
  if (tw === null) return { symbol: `${code}.TW`, resolved: false }

  const two = await probe(`${code}.TWO`)
  if (two === true) return { symbol: `${code}.TWO`, resolved: true }

  // .TW said a definitive no and .TWO did not confirm: probably OTC and
  // unreachable, or the code does not exist. Report the guess for display but
  // mark it unresolved so nothing persists it.
  return { symbol: `${code}.TWO`, resolved: false }
}

const _memo = new Map<string, string>()   // raw upper → canonical (successes only)

/** Test hook: clear the resolution memo between cases. */
export function clearSymbolMemo(): void { _memo.clear() }

/**
 * Canonicalise a user-typed symbol. Never throws.
 *
 * An exchange listing does not move, so successful resolutions are memoised for
 * the process lifetime; failures are not cached, so a Yahoo outage does not
 * pin a wrong answer in memory until the next deploy.
 */
export async function resolveSymbol(raw: string, probe?: ProbeFn): Promise<ResolvedSymbol> {
  const upper = raw.toUpperCase().trim()

  const memoised = _memo.get(upper)
  if (memoised) {
    const { adapter } = getAdapter(memoised)
    return { symbol: memoised, assetType: adapter.getAssetType(), resolved: true }
  }

  const { adapter } = getAdapter(upper)
  if (adapter.getAssetType() === "crypto") {
    return { symbol: upper, assetType: "crypto", resolved: true }
  }

  const twCode = TW_BARE.test(upper) ? upper : TW_SUFFIXED.exec(upper)?.[1]
  if (!twCode) {
    // US ticker (or any other exchange suffix the user gave explicitly) —
    // nothing to disambiguate.
    return { symbol: upper, assetType: "stock", resolved: true }
  }

  const probeFn: ProbeFn = probe ?? (s => adapter.probe?.(s) ?? Promise.resolve(null))
  const { symbol, resolved } = await resolveTwSuffix(twCode, probeFn)
  if (resolved) _memo.set(upper, symbol)
  return { symbol, assetType: "stock", resolved }
}
