export type AssetType = "stock" | "crypto"

export interface OHLCV {
  date:   string   // "YYYY-MM-DD"
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}

export interface ChartData {
  symbol:     string
  asset_type: AssetType
  ohlcv:      OHLCV[]
  ma25:       (number | null)[]
  ma60:       (number | null)[]
  signal:     import("./signal.js").SignalType
  confidence: import("./signal.js").Confidence
  signal_date: string | null
}
