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

export interface BacktestResult {
  symbol:      string
  bars:        number
  from_date:   string
  to_date:     string
  trades:      BacktestTrade[]
  open_position: OpenPosition | null
  win_count:   number
  loss_count:  number
  win_rate:    number | null    // null when no closed trades
  avg_return:  number | null
  best_trade:  number | null
  worst_trade: number | null
}

export function runBacktest(symbol: string, ohlcv: OHLCV[]): BacktestResult {
  if (ohlcv.length < 65) {
    return {
      symbol, bars: ohlcv.length,
      from_date: ohlcv[0]?.date ?? "", to_date: ohlcv.at(-1)?.date ?? "",
      trades: [], open_position: null,
      win_count: 0, loss_count: 0, win_rate: null, avg_return: null,
      best_trade: null, worst_trade: null,
    }
  }

  const closes  = ohlcv.map(b => b.close)
  const volumes = ohlcv.map(b => b.volume)
  const ma25    = computeMA(closes, 25)
  const ma60    = computeMA(closes, 60)
  const rsiSer  = computeRSI(closes)
  const macdSer = computeMACD(closes)

  const trades: BacktestTrade[] = []
  let open: { date: string; price: number; confidence: Confidence; factorsPassed: number } | null = null

  for (let i = 61; i < ohlcv.length; i++) {
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

  return {
    symbol,
    bars:      ohlcv.length,
    from_date: ohlcv[0].date,
    to_date:   lastDate,
    trades,
    open_position: openPosition,
    win_count:  winCount,
    loss_count: lossCount,
    win_rate:   returns.length > 0 ? winCount / returns.length : null,
    avg_return: returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : null,
    best_trade:  returns.length > 0 ? Math.max(...returns) : null,
    worst_trade: returns.length > 0 ? Math.min(...returns) : null,
  }
}
