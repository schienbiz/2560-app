# TODOS

Items deferred from the trade journal expansion plan. Each item has context so it's
actionable 3 months from now, not just a vague bullet.

---

## Configurable proximity threshold per-symbol

**What:** Replace the hardcoded `PROXIMITY_THRESHOLD = 0.015` in `cron/scan.ts` with a
per-symbol threshold stored in `WatchlistAlert` and configurable from the Reminders tab UI.

**Why:** 1.5% is a starting point. After a week of real data you'll know if it's too tight
(no alerts) or too loose (too many). Right now tuning requires a code edit + redeploy.

**Pros:** No redeploy needed to tune. Per-symbol granularity (crypto vs TW stocks move differently).
**Cons:** Prisma migration required (new Float field on WatchlistAlert). UI input in Reminders tab.

**Context:** Skipped in CEO plan 2026-04-22. Start at 1.5% hardcoded. Revisit after 1 week
of proximity alert data. Build after you've seen which symbols fire too much/too little.

**Depends on:** Proximity alert working in production (v1 of AI watchdog shipped)

---

## Intraday proximity alerts

**What:** Move from daily-close price checks to intraday WebSocket price feed. Alert the moment
price touches the MA25 zone during trading hours, not 24 hours later at the nightly scan.

**Why:** The most useful moment for the 2560 strategy is when price hits the zone. Daily close
means you're always 1 candle late. Intraday means you can actually enter at the zone.

**Pros:** Dramatically better timing. Completes the "stop watching the chart" promise.
**Cons:** Requires a real-time price feed (Binance WebSocket for crypto, Fugle/PushAPI for TW
stocks). Render free tier doesn't sustain continuous WebSocket connections — needs paid tier
or a different hosting model (Fly.io, Railway, or a dedicated WebSocket server).

**Context:** Identified in CEO plan 2026-04-22 10x check. Day 1 version (daily close) ships
first. Revisit once the app has regular users and the daily-close pattern is validated.

**Depends on:** Daily-close proximity alert live + validated; hosting upgrade decision

---

## Alert history: outcome tracking

**What:** Extend the alert history log (coming in v1 AI watchdog) with outcome tracking. After
each proximity/cross alert, did price move in the predicted direction? Show: "5 days after this
proximity alert, the stock was +4.2%".

**Why:** Turns the alert history from a log into a feedback loop. You can see whether the
2560戰法 proximity signals are actually accurate in practice.

**Pros:** Closes the strategy-verification loop. Differentiates from any off-the-shelf signal tool.
**Cons:** Requires knowing the "target" (entry at close on alert day, evaluate 5/10/20 days later).
Data is already in TradeRecord — could cross-reference automatically.

**Context:** Deferred from CEO plan 2026-04-22. Ship alert history (v1) first, then add outcomes.

**Depends on:** Alert history log shipped and in use for at least 2 weeks

---

## Community leaderboard

**What:** Public opt-in win rates. "Top 2560 traders this month." Viral LINE acquisition.

**Why:** The 10x version of this product is a community-verified strategy journal. Social
proof via leaderboard is the organic acquisition channel. Can't build this until we know
there's a community to attract.

**Pros:** Organic LINE group distribution without paid ads. Natural viral loop.
**Cons:** Requires multi-user identity (users opt-in to public profiles), moderation
concerns, needs enough traders for the leaderboard to be meaningful.

**Context:** Deferred from CEO plan 2026-04-21. Premise 1 (Taiwan retail investors use
2560 strategy as a community, not just individually) is unvalidated. Pre-build assignment:
post PTT Stock board "請問有人用25日均線和60日均線的黃金交叉死亡交叉作為主要買賣依據嗎？"
and count replies in 48h. If 10+ engaged replies → community acquisition viable →
design leaderboard. If < 10 → invite-led growth only.

**Depends on:** PTT experiment result + multi-user growth (3+ active users)

---

## Monthly stats DB-side aggregation

**What:** Move monthly P&L computation from in-memory (compute on read) to a
pre-aggregated DB query or materialized view.

**Why:** `computeStats()` currently runs over all user trades in memory. Fine at 1000
trades/user. At 5000+ trades/user, this becomes slow enough to notice (~100ms+).

**Pros:** Fast stats at scale. Enables future analytics (year-over-year, multi-symbol).
**Cons:** Adds complexity (migration, cache invalidation on trade create/update/delete).
Don't do this before it's needed — premature optimization.

**Context:** Threshold: when a single user exceeds 5000 trades. Architecture Notes in
the CEO plan say "compute on read is fine — add DB-side aggregation if needed."
Start with `GROUP BY DATE_TRUNC('month', entry_date)` in a raw Prisma query before
building a materialized view.

**Depends on:** User activity (5000+ trades is far away for a personal tool)

---

## lineTokenCache bounded LRU

**What:** Replace the unbounded `Map` in `src/auth.ts` with a bounded LRU cache that
evicts the oldest tokens when the cache exceeds N entries.

**Why:** The current `lineTokenCache` Map grows with every unique LINE token seen.
For a single user this doesn't matter. For 100+ concurrent users with session rotation,
the Map could leak memory over time (tokens expire but are only evicted on access).

**Pros:** Prevents memory leak in multi-user scenario.
**Cons:** Adds a dependency (`lru-cache` npm package) or requires a manual LRU implementation.
1-user app doesn't need this yet.

**Context:** Found during /plan-eng-review on 2026-04-21. The auth.ts cache currently
has a 1-hour TTL but no eviction for entries that are never re-accessed. Revisit when
the user base exceeds 50 concurrent users.

**Depends on:** Multi-user launch (Scope deferred in CEO plan — community validation first)
