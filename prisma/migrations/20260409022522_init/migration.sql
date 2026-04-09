-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('line', 'telegram');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('stock', 'crypto');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('golden_cross', 'death_cross', 'none');

-- CreateEnum
CREATE TYPE "TradeDirection" AS ENUM ('long', 'short');

-- CreateTable
CREATE TABLE "Watchlist" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "symbol" TEXT NOT NULL,
    "asset_type" "AssetType" NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Watchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistAlert" (
    "id" TEXT NOT NULL,
    "watchlist_id" TEXT NOT NULL,
    "on_golden" BOOLEAN NOT NULL DEFAULT true,
    "on_death" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "WatchlistAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemindMe" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "symbol" TEXT NOT NULL,
    "asset_type" "AssetType" NOT NULL,
    "remind_date" DATE NOT NULL,
    "note" TEXT,
    "sent" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemindMe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalHistory" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "asset_type" "AssetType" NOT NULL,
    "signal" "SignalType" NOT NULL,
    "signal_date" TIMESTAMP(3) NOT NULL,
    "close_price" DOUBLE PRECISION NOT NULL,
    "ma25" DOUBLE PRECISION NOT NULL,
    "ma60" DOUBLE PRECISION NOT NULL,
    "confidence" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeRecord" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "symbol" TEXT NOT NULL,
    "asset_type" "AssetType" NOT NULL,
    "watchlist_id" TEXT,
    "signal_id" TEXT,
    "direction" "TradeDirection" NOT NULL DEFAULT 'long',
    "entry_date" TIMESTAMP(3) NOT NULL,
    "entry_price" DOUBLE PRECISION NOT NULL,
    "exit_date" TIMESTAMP(3),
    "exit_price" DOUBLE PRECISION,
    "quantity" DOUBLE PRECISION,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OhlcvCache" (
    "symbol" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Watchlist_user_id_platform_symbol_key" ON "Watchlist"("user_id", "platform", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistAlert_watchlist_id_key" ON "WatchlistAlert"("watchlist_id");

-- CreateIndex
CREATE INDEX "RemindMe_remind_date_sent_idx" ON "RemindMe"("remind_date", "sent");

-- CreateIndex
CREATE INDEX "SignalHistory_symbol_signal_date_idx" ON "SignalHistory"("symbol", "signal_date");

-- CreateIndex
CREATE UNIQUE INDEX "SignalHistory_symbol_signal_date_signal_key" ON "SignalHistory"("symbol", "signal_date", "signal");

-- CreateIndex
CREATE INDEX "TradeRecord_user_id_platform_idx" ON "TradeRecord"("user_id", "platform");

-- CreateIndex
CREATE INDEX "OhlcvCache_symbol_date_idx" ON "OhlcvCache"("symbol", "date");

-- CreateIndex
CREATE UNIQUE INDEX "OhlcvCache_symbol_date_key" ON "OhlcvCache"("symbol", "date");

-- AddForeignKey
ALTER TABLE "WatchlistAlert" ADD CONSTRAINT "WatchlistAlert_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "Watchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRecord" ADD CONSTRAINT "TradeRecord_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "Watchlist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeRecord" ADD CONSTRAINT "TradeRecord_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "SignalHistory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
