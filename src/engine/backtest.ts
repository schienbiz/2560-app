/**
 * Backtesting engine — simulates 2560戰法 on historical OHLCV.
 *
 * Strategy:
 *   Entry: golden_cross bar (MA25 crosses above MA60), no open position
 *   Exit:  death_cross bar (MA25 crosses below MA60)
 *   Final: any open position closed at last available bar (unrealized)
 *
 * Each entry records 4-factor confidence at the signal bar (same logic as
 * live scoreSignal), so you can filter or compare high vs. medium vs. low.
 *
 * All functions are pure: no DB, no side effects.
 */

import type { OHLCV } from "./types.js"
import type { Confidence } from "./signal.js"
import { computeMA } from "./ma.js"
import { computeRSI, computeMACD } from "./indicators.js"

export interface BacktestTrade {
  entry_date:     string
  exit_date:      string
  entry_price:    number
  exit_price:     number
  return_pct:     number
  confidence:     Confidence
  factors_passed: number        // 0–4 (how many of 4 factors confirmed entry)
  holding_days:   number
}

export interface OpenPosition {
  entry_date:     string
  entry_price:    number
  confidence:     Confidence
  factors_passed: number
  unrealized_pct: number        // vs. last available close
}

export interface ConfidenceGroup {
  count:      number
  win_count:  number
  win_rate:   number | null
  avg_return: number | null
}

export interface BacktestResult {
  symbol:        string
  bars:          number
  from_date:     string
  to_date:       string
  trades:        BacktestTrade[]
  open_position: OpenPosition | null
  win_count:     number
  loss_count:    number
  win_rate:      number | null
  avg_return:    number | null
  avg_win:       number | null  // avg return of winning trades
  avg_loss:      number | null  // avg return of losing trades (negative)
  best_trade:    number | null
  worst_trade:   number | null
  profit_factor: number | null  // gross_profit / |gross_loss|
  max_drawdown:  number | null  // max peak-to-trough in cumulative equity, as %
  expectancy:    number | null  // win_rate*avg_win + loss_rate*avg_loss
  cumulative:    number[]       // cumulative equity curve (1.0 = starting capital)
  by_confidence: { high: ConfidenceGroup; medium: ConfidenceGroup; low: ConfidenceGroup }
}

export function runBacktest(symbol: string, ohlcv: OHLCV[], fastPeriod = 25, slowPeriod = 60): BacktestResult {
  if (ohlcv.length < slowPeriod + 5) {
    return {
      symbol, bars: ohlcv.length,
      from_date: ohlcv[0]?.date ?? "", to_date: ohlcv.at(-1)?.date ?? "",
      trades: [], open_position: null,
      win_count: 0, loss_count: 0, win_rate: null, avg_return: null,
      avg_win: null, avg_loss: null, best_trade: null, worst_trade: null,
      profit_factor: null, max_drawdown: null, expectancy: null,
      cumulative: [],
      by_confidence: {
        high:   { count: 0, win_count: 0, win_rate: null, avg_return: null },
        medium: { count: 0, win_count: 0, win_rate: null, avg_return: null },
        low:    { count: 0, win_count: 0, win_rate: null, avg_return: null },
      },
    }
  }

  const closes  = ohlcv.map(b => b.close)
  const volumes = ohlcv.map(b => b.volume)
  const ma25    = computeMA(closes, fastPeriod)
  const ma60    = computeMA(closes, slowPeriod)
  const rsiSer  = computeRSI(closes)
  const macdSer = computeMACD(closes)

  const trades: BacktestTrade[] = []
  let open: { date: string; price: number; confidence: Confidence; factorsPassed: number } | null = null

  for (let i = slowPeriod + 1; i < ohlcv.length; i++) {
    const p25 = ma25[i - 1], c25 = ma25[i]
    const p60 = ma60[i - 1], c60 = ma60[i]
    if (p25 == null || c25 == null || p60 == null || c60 == null) continue

    const isGolden = p25 <= p60 && c25 > c60
    const isDeath  = p25 >= p60 && c25 < c60

    if (isGolden && !open) {
      // Evaluate 4-factor confidence at this bar
      const recentVol = volumes.slice(Math.max(0, i - 10), i)
      const avgVol    = recentVol.length > 0 ? recentVol.reduce((s, v) => s + v, 0) / recentVol.length : 0
      const volOk     = avgVol > 0 && volumes[i] > avgVol * 1.2
      const proxOk    = Math.abs(closes[i] - c60) / c60 <= 0.15
      const rsi       = rsiSer[i]
      const rsiOk     = rsi != null ? rsi > 50 : false
      const hist      = macdSer.histogram[i]
      const macdOk    = hist != null ? hist > 0 : false

      const passed: number = [volOk, proxOk, rsiOk, macdOk].filter(Boolean).length
      const confidence: Confidence = passed >= 3 ? "high" : passed >= 2 ? "medium" : "low"

      open = { date: ohlcv[i].date, price: closes[i], confidence, factorsPassed: passed }
    }

    if (isDeath && open) {
      const ret        = (closes[i] - open.price) / open.price * 100
      const entryMs    = new Date(open.date).getTime()
      const exitMs     = new Date(ohlcv[i].date).getTime()
      const holdDays   = Math.round((exitMs - entryMs) / 86_400_000)

      trades.push({
        entry_date:     open.date,
        exit_date:      ohlcv[i].date,
        entry_price:    open.price,
        exit_price:     closes[i],
        return_pct:     ret,
        confidence:     open.confidence,
        factors_passed: open.factorsPassed,
        holding_days:   holdDays,
      })
      open = null
    }
  }

  const lastClose = closes[closes.length - 1]
  const lastDate  = ohlcv.at(-1)!.date

  const openPosition: OpenPosition | null = open
    ? {
        entry_date:     open.date,
        entry_price:    open.price,
        confidence:     open.confidence,
        factors_passed: open.factorsPassed,
        unrealized_pct: (lastClose - open.price) / open.price * 100,
      }
    : null

  const returns   = trades.map(t => t.return_pct)
  const winCount  = returns.filter(r => r > 0).length
  const lossCount = returns.filter(r => r <= 0).length
  const wins      = returns.filter(r => r > 0)
  const losses    = returns.filter(r => r <= 0)

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null

  const grossProfit = wins.reduce((s, v) => s + v, 0)
  const grossLoss   = Math.abs(losses.reduce((s, v) => s + v, 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null)

  // Equity curve: cumulative product starting at 1.0
  const cumulative: number[] = []
  let equity = 1.0
  for (const t of trades) {
    equity *= (1 + t.return_pct / 100)
    cumulative.push(parseFloat(equity.toFixed(4)))
  }

  // Max drawdown from equity curve peaks
  let maxDD = 0
  let peak = 1.0
  let cur  = 1.0
  for (const t of trades) {
    cur *= (1 + t.return_pct / 100)
    if (cur > peak) peak = cur
    const dd = (peak - cur) / peak * 100
    if (dd > maxDD) maxDD = dd
  }

  // By-confidence breakdown
  const confGroup = (level: "high" | "medium" | "low"): ConfidenceGroup => {
    const ts = trades.filter(t => t.confidence === level)
    const wc = ts.filter(t => t.return_pct > 0).length
    return {
      count:      ts.length,
      win_count:  wc,
      win_rate:   ts.length > 0 ? wc / ts.length : null,
      avg_return: avg(ts.map(t => t.return_pct)),
    }
  }

  const avgWin  = avg(wins)
  const avgLoss = avg(losses)
  const winRate = returns.length > 0 ? winCount / returns.length : null
  const lossRate = winRate != null ? 1 - winRate : null
  const expectancy = (avgWin != null && avgLoss != null && winRate != null && lossRate != null)
    ? winRate * avgWin + lossRate * avgLoss
    : null

  return {
    symbol,
    bars:          ohlcv.length,
    from_date:     ohlcv[0].date,
    to_date:       lastDate,
    trades,
    open_position: openPosition,
    win_count:     winCount,
    loss_count:    lossCount,
    win_rate:      winRate,
    avg_return:    avg(returns),
    avg_win:       avgWin,
    avg_loss:      avgLoss,
    best_trade:    returns.length > 0 ? Math.max(...returns) : null,
    worst_trade:   returns.length > 0 ? Math.min(...returns) : null,
    profit_factor: profitFactor === Infinity ? null : profitFactor,
    max_drawdown:  returns.length > 0 ? parseFloat(maxDD.toFixed(2)) : null,
    expectancy:    expectancy != null ? parseFloat(expectancy.toFixed(2)) : null,
    cumulative,
    by_confidence: {
      high:   confGroup("high"),
      medium: confGroup("medium"),
      low:    confGroup("low"),
    },
  }
}
