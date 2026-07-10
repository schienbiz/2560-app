-- AlterTable: persist the 5-factor strong-death score at signal time (so live
-- precision can be measured against the backtest claim) and the market-index
-- return over the same outcome windows (so signal outcomes can be judged
-- against the regime instead of raw price alone).
ALTER TABLE "SignalHistory"
  ADD COLUMN "strong_passed" INTEGER,
  ADD COLUMN "strong_applicable" INTEGER,
  ADD COLUMN "benchmark_5d" DOUBLE PRECISION,
  ADD COLUMN "benchmark_10d" DOUBLE PRECISION,
  ADD COLUMN "benchmark_20d" DOUBLE PRECISION;
