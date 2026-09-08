/**
 * Shared retry wrapper for the market-data adapters.
 *
 * Why this exists: a scan reads each symbol exactly once, and `scoreSignal` in
 * the cron path uses lookback=1 — it only fires on the LAST bar's transition.
 * So a single transient Yahoo/Kraken failure at scan time does not merely delay
 * that symbol: by tomorrow the cross is no longer the last bar and it is never
 * detected at all. One retry converts the most common transient shapes
 * (rate limit, gateway blip, dropped connection) into a non-event.
 *
 * Deliberately NOT retried:
 *   - 404 / 4xx other than 429 — a definitive answer. The Taiwan .TW/.TWO
 *     probe relies on 404 coming back fast; retrying it would triple the cost
 *     of every OTC symbol lookup for no gain.
 *   - AbortSignal.timeout aborts from the CALLER's signal (see note below).
 */

/** Retried once: rate limiting and server-side faults. */
function isRetriableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number
  /** Delay before the retry, ms. */
  backoffMs?: number
  /** Per-attempt timeout, ms. */
  timeoutMs?: number
  headers?: Record<string, string>
}

/**
 * GET `url`, retrying once on a retriable status or a network/timeout error.
 *
 * Each attempt gets its OWN AbortSignal — a single shared `AbortSignal.timeout`
 * would already be aborted by the time the retry ran, so the retry would fail
 * instantly and silently look like a second genuine failure.
 */
export async function fetchWithRetry(url: string, opts: RetryOptions = {}): Promise<Response> {
  const attempts  = opts.attempts  ?? 2
  const backoffMs = opts.backoffMs ?? 500
  const timeoutMs = opts.timeoutMs ?? 8_000

  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, backoffMs * i))
    try {
      const res = await fetch(url, {
        headers: opts.headers,
        signal:  AbortSignal.timeout(timeoutMs),
      })
      if (isRetriableStatus(res.status) && i < attempts - 1) {
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (i === attempts - 1) throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
