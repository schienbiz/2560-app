/**
 * Win rate and P&L statistics computed from trade records.
 * Pure functions — no DB access.
 *
 * COMPUTATION FLOW:
 *   TradeRecord[] ──► computeStats()
 *                          │
 *              ┌───────────┼────────────┐
 *           total      bySignal      bySymbol (future)
 */

export type SignalType = "golden_cross" | "death_cross" | "none" | "manual"

export interface TradeSummary {
  count:      number         // total trades (including open)
  closed:     number         // exit_price filled
  open:       number         // still holding
  wins:       number         // closed + profitable
  losses:     number         // closed + unprofitable
  winRate:    number | null  // wins / closed (0–100), null if no closed trades
  avgReturn:  number | null  // average % return on closed trades, null if no closed trades
  maxWin:     number | null  // best single trade %, null if no closed trades
  maxLoss:    number | null  // worst single trade %, null if no closed trades
}

export interface StatsResult {
  total:    TradeSummary
  bySignal: Partial<Record<SignalType, TradeSummary>>
}

// Minimal trade shape needed for stats — no DB types imported here
export interface TradeLike {
  entry_price:  number
  exit_price:   number | null
  direction?:   "long" | "short" | null
  signal_type?: SignalType | null   // populated by join in the route
}

function returnPct(entry: number, exit: number, direction: "long" | "short" | null | undefined): number {
  const raw = ((exit - entry) / entry) * 100
  return direction === "short" ? -raw : raw
}

function summarize(trades: TradeLike[]): TradeSummary {
  const closed = trades.filter(t => t.exit_price !== null) as Array<TradeLike & { exit_price: number }>
  const open = trades.length - closed.length

  const returns = closed.map(t => returnPct(t.entry_price, t.exit_price, t.direction))
  const wins = returns.filter(r => r > 0).length
  const losses = returns.filter(r => r <= 0).length

  return {
    count:     trades.length,
    closed:    closed.length,
    open,
    wins,
    losses,
    winRate:   closed.length > 0 ? (wins / closed.length) * 100 : null,
    avgReturn: returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : null,
    maxWin:    returns.length > 0 ? Math.max(...returns) : null,
    maxLoss:   returns.length > 0 ? Math.min(...returns) : null,
  }
}

export function computeStats(trades: TradeLike[]): StatsResult {
  const groups: Partial<Record<SignalType, TradeLike[]>> = {}

  for (const t of trades) {
    const key: SignalType = t.signal_type ?? "manual"
    groups[key] ??= []
    groups[key]!.push(t)
  }

  const bySignal: Partial<Record<SignalType, TradeSummary>> = {}
  for (const [key, group] of Object.entries(groups) as [SignalType, TradeLike[]][]) {
    bySignal[key] = summarize(group)
  }

  return { total: summarize(trades), bySignal }
}
