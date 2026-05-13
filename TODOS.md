# TODOS

Items deferred from the trade journal expansion plan. Each item has context so it's
actionable 3 months from now, not just a vague bullet.

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

---

## DESIGN.md — living design spec

**What:** Create a `DESIGN.md` in the repo root that documents the app's design system:
color tokens (`--green`, `--red`, `--yellow`, `--blue`, `--muted`), component classes
(`.badge`, `.badge-compact`, `.btn`, `.card`, `.stat-card`, `.sheet`), spacing scale,
and interaction patterns (toast, bottom sheet, tab navigation).

**Why:** Every session re-derives the same design rules from `index.html`. A spec
reduces AI drift (badge-compact vs inline styles, danger vs muted color semantics)
and makes onboarding faster if collaborators join.

**Pros:** Faster future sessions. Prevents design system drift. Single source of truth
for component classes and color usage.
**Cons:** Maintenance overhead — needs to stay in sync with `index.html` changes.

**Context:** Surfaced during /plan-design-review on 2026-04-26 (3-feature batch: swing
markers, outcome tracking, per-symbol proximity threshold). Not blocking any feature work —
write it during a quiet session before the next major UI expansion.

**Depends on:** Nothing — standalone doc task

---

## Social Layer v2 — In-app Watcher Count (Approach B)

**What:** Add "N other users watching this symbol" to each watchlist card in the authenticated app UI.
Show watcher count as a small badge on the symbol row. Pull from the same `WatchlistAlert groupBy`
query used by the Signal Pulse page. Opt-in: only count users who have joined with at least one
active watchlist alert.

**Why:** Signal Pulse (v1.3.0) validated that users want to know who else is watching the same
symbols. Approach B brings that answer *into* the authenticated experience — not just on the public
page. Knowing "8 others watching TSMC at MA25 proximity" at the moment the alert fires dramatically
increases conviction to act. This is the confidence amplifier feature.

**Build gate:** Only start Approach B after Signal Pulse clears its validation gate:
- ≥5 genuine replies to the PTT demand test post (posted after PR #5 merges)
- AND ≥10 new signups from the Signal Pulse public page within 48h of going live

**Architecture (pre-specced, ready to implement):**
- No schema change needed. Reuse `WatchlistAlert` groupBy query from Signal Pulse.
- Add a `getWatcherCounts()` function to a shared service (e.g., `src/services/watchlist.ts`).
  Cache counts in-memory for 5 minutes (longer than Signal Pulse's 60s — auth app has fewer page loads).
- In the watchlist API response, join watcher count per symbol.
- In `public/pages/watchlist.js`, render a small badge: `<span class="badge-compact">👥 N</span>`
  if count ≥ 2. Hide if count = 1 (would reveal only 1 user watches it).

**Pros:** Delivers the core social value ("am I seeing this the same way as other disciplined traders?")
directly in the tool where users act on signals.
**Cons:** Only meaningful once there are ≥5 active users with overlapping watchlists. At 1-2 users,
all counts will be 1 and hidden — the feature is invisible. Don't ship until there's enough activity.

**Context:** Designed during CEO plan 2026-04-26 as the validated follow-on to Signal Pulse.
/office-hours session identified "who else is watching" as the core social demand signal.

**Depends on:** Signal Pulse (v1.3.0) validation gate: ≥5 PTT replies AND ≥10 new signups

---

## SignalHistory column rename (fast_ma / slow_ma)

**What:** Rename `SignalHistory.ma25` and `ma60` columns to `fast_ma` and `slow_ma`.

**Why:** After the Configurable MA Pairs feature, these columns store the fast and slow MA values
for whatever periods the user configured. A user with MA5/MA20 has their MA5 value stored in
the `ma25` column — misleading for any future developer or query reading signal history.

**Pros:** Semantically correct column names. Future signal history UI can read `fast_ma`/`slow_ma`
and correctly label them without knowing the original period.
**Cons:** Requires a Prisma migration (rename columns) + update cron/scan.ts writes. Breaking
if any analytics query reads `ma25`/`ma60` directly. Low risk today since no history UI exists.

**Context:** Accepted as safe deferral in /plan-eng-review 2026-05-13 (D2). The table is
write-only — no display or analytics reads back these values. Fix at the point when a signal
history display or analytics query is first built. Don't do it earlier (unnecessary migration).

**Depends on:** Signal history UI feature being planned.

---

## cache.ts bar-depth check understates minimum for large slow_period

**What:** Revise `getCachedOHLCV`'s minimum bar count check from `Math.min(days, 60)` to
`Math.ceil(days * 0.65)` or a similar trading-day-aware formula.

**Why:** With `days=320` (slow_period=200), the current check only requires ≥60 rows in the
DB for a cache hit. A cold cache with 70 rows returns a false hit: the caller gets 70 bars,
MA200 computes nulls. Currently safe because `cron/scan.ts`'s bar guard (slow_period + 5
check) catches this and emits `insufficient_data`. If the bar guard is ever weakened or
removed, this becomes a silent wrong-MA bug.

**Pros:** Removes the latent dependency on the bar guard. Cache correctly invalidates when
bar depth is insufficient for the requested period.
**Cons:** More DB misses on first runs, triggering more Yahoo/Kraken fetches.

**Context:** Found during /plan-eng-review 2026-05-13. Currently defended by the bar guard.
Fix during any future cache refactor. Do not fix in isolation — it changes cache behavior.

**Depends on:** Any future cache layer refactor. Independent otherwise.

---

## PTT demand validation experiment

**What:** Post on PTT Stock board: "請問有人用不同的均線組合（不是固定25/60）作為買賣依據嗎？"
Count engaged replies within 48h.

**Why:** Approach A (Configurable MA Pairs) was built on the assumption that traders use
non-25/60 MA pairs. The PTT experiment validates whether there is actually demand from
Taiwan retail traders beyond the beachhead user (one friend/family member).

**Signal reading:**
- ≥5 engaged replies → demand validated → Approach B (multi-strategy alert platform) moves to roadmap
- < 5 replies → distribution is the bottleneck, not strategy flexibility → focus on getting more users

**Pros:** Low cost (15 minutes to write the post). Real demand signal from the actual audience.
**Cons:** PTT requires a registered account. Results depend on post timing (market hours vs. weekend).

**Context:** The design doc (Premise 3) explicitly flagged this as unrun. The assignment from
the 2026-05-13 office hours session: post BEFORE writing more code. The configurable MA Pairs
feature should be shipped first so there's something to link to.

**Depends on:** Configurable MA Pairs feature shipped.

---

## Completed

### Configurable proximity threshold per-symbol
**Completed:** v1.2.0 (2026-04-26)

Per-symbol `proximity_threshold` field added to `WatchlistAlert` (Prisma migration
`20260426060723`). `cron/scan.ts` reads per-alert value with 1.5% default fallback.
Settings sheet in watchlist UI exposes a slider (0.5%–10%) with live MA25 ± N
absolute-price context hint. Slider grayed when golden cross notifications are off.

### Alert history: outcome tracking
**Completed:** v1.2.0 (2026-04-26)

`cron/outcome.ts` computes 5d/10d/20d % returns for `golden_cross`/`death_cross`
signals after a 10-day eligibility window, looking up `OhlcvCache` for price at
+7/+14/+28 calendar days. Results written back to `SignalHistory` fields
`outcome_5d`, `outcome_10d`, `outcome_20d`. Displayed as `.badge-compact` rows in
the signal history card. Daily GitHub Actions cron at 18:00 Taipei time.
