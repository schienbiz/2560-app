import type { OHLCV, AssetType } from "../engine/types.js"

export interface MarketAdapter {
  getAssetType(): AssetType
  /**
   * Name of the upstream feed, stored in `OhlcvCache.source`.
   *
   * That column was documented as `"yahoo" | "binance"` but every row actually
   * held `"stock"` / `"crypto"` (11157 / 994 rows in production): each caller
   * passed `assetType` into the `source` parameter, so the column recorded
   * something the `asset_type` columns already say and nothing about where the
   * bars came from. Making it a method removes the chance to pass the wrong
   * string.
   */
  getSource(): string
  validateSymbol(symbol: string): Promise<boolean>
  /** Fetch the last `days` calendar days of daily OHLCV. */
  fetchOHLCV(symbol: string, days: number): Promise<OHLCV[]>
  /**
   * Fetch the current live/intraday price.
   * Returns null when the market is closed or the source is unavailable.
   * Falls back to the last OHLCV close in ws.ts when null.
   */
  fetchQuote(symbol: string): Promise<number | null>
  /**
   * Does this source serve daily bars for this EXACT symbol?
   * true = yes, false = definitively not, null = could not determine.
   * Used by utils/symbol.ts to choose .TW vs .TWO before a symbol is
   * persisted; only the Yahoo adapter needs it, so it is optional.
   */
  probe?(symbol: string): Promise<boolean | null>
}
