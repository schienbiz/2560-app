-- AlterTable
ALTER TABLE "SignalHistory" ADD COLUMN     "outcome_10d" DOUBLE PRECISION,
ADD COLUMN     "outcome_20d" DOUBLE PRECISION,
ADD COLUMN     "outcome_5d" DOUBLE PRECISION,
ADD COLUMN     "outcome_computed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WatchlistAlert" ADD COLUMN     "proximity_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.015;
