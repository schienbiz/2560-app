-- CreateTable: per-user notification ledger.
--
-- Notification dedup was keyed on SignalHistory, which is a GLOBAL fact — one
-- row per (symbol, signal_date, signal). The scan sends per ALERT, so the first
-- alert processed for a symbol wrote that row and every other user watching the
-- same symbol saw "already sent" and was skipped. It has been surviving purely
-- on a race: all alerts run concurrently and all read before the first write.
-- Production has BTCUSDT watched by two distinct users on LINE and two more on
-- Telegram, so any serialisation would start silently dropping notifications.
--
-- The unique constraint is the idempotency key: the sender claims it with an
-- INSERT and lets the constraint decide, rather than a read-then-write.
CREATE TABLE "SignalNotification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "symbol" TEXT NOT NULL,
    "signal" "SignalType" NOT NULL,
    "signal_date" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignalNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SignalNotification_user_id_platform_symbol_signal_date_signal_key"
    ON "SignalNotification"("user_id", "platform", "symbol", "signal_date", "signal");

-- CreateIndex
CREATE INDEX "SignalNotification_symbol_signal_date_idx"
    ON "SignalNotification"("symbol", "signal_date");
