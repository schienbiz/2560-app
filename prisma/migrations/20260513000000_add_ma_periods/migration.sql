-- AddColumn fast_period and slow_period to WatchlistAlert
ALTER TABLE "WatchlistAlert" ADD COLUMN "fast_period" INTEGER NOT NULL DEFAULT 25;
ALTER TABLE "WatchlistAlert" ADD COLUMN "slow_period" INTEGER NOT NULL DEFAULT 60;
