import type { OHLCV, AssetType } from "../engine/types.js"

export interface MarketAdapter {
  getAssetType(): AssetType
  validateSymbol(symbol: string): Promise<boolean>
  /** Fetch the last `days` calendar days of daily OHLCV. */
  fetchOHLCV(symbol: string, days: number): Promise<OHLCV[]>
}
