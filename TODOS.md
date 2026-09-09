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
the Map could still grow between sweeps. (An hourly `setInterval` in `src/auth.ts` does
purge expired entries, so this is bounded by an hour of traffic, not truly unbounded — the LRU
would bound it by SIZE instead, which is the property that actually matters under load.)

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
Update 2026-07-03: the interactive/live surfaces (chart, scan, ws, ai) now also gate on
`hasSufficientBars(len, slowPeriod)` and flag `insufficient_history`, so an under-provisioned
cache no longer emits a phantom cross — it returns `signal: none` + the flag. The cache still
returns too-few bars though; this item is the root fix.

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

## Confidence factors: RSI/MACD measured at latest bar, not cross bar

**What:** In `scoreSignal` (`src/engine/signal.ts`), factor 1 (volume) is evaluated at the
cross bar (`volumes[crossIndex]`), but factors 3 and 4 (RSI, MACD) use `lastNonNull(...)` —
the *latest* bar. When the cross happened a few bars ago (findRecentSignal lookback is up to
5), the momentum factors describe "now", not the moment of the cross.

**Why:** For confidence to mean "how well-confirmed was this cross", all four factors should
be read at the same reference point (the cross bar). Mixing cross-bar and latest-bar readings
means a cross that was strong when it fired can be downgraded by a later pullback, or vice
versa. It's a subtle scoring skew, not a correctness bug.

**Pros:** Coherent, single-reference-point confidence. Easier to explain in the manual.
**Cons:** Changes confidence values for any symbol whose cross is not on the latest bar —
needs new golden-master test values. Also arguably the *current* behavior (latest-bar momentum)
is what a trader deciding "should I act now" wants, so this is a product call, not a clear fix.

**Context:** Surfaced during the 2026-07-02 極致優化 review of the confidence engine, alongside
the applicable-ratio fix (v1.3.1). Deliberately left as-is because the two readings serve
different questions ("was the cross clean" vs "is momentum aligned right now"). Decide the
intended semantics before changing.

**Depends on:** A product decision on what confidence should measure. Independent otherwise.

---

## Standby Render backend: RENDER_HOOK_SCHIENBIZ hook is optional (not needed for sync)

**What:** Optionally set the `RENDER_HOOK_SCHIENBIZ` GitHub Actions secret (the `two560-app` /
schienbiz Render Deploy Hook URL) so `deploy-sync.yml` also pings the standby on each push to
`main`. Currently unset → the workflow's schienbiz step skips gracefully.

**Why it's optional (corrected 2026-07-05):** the original assumption here — "the standby drifts
behind until the hook is set" — is wrong. schienbiz has **native GitHub auto-deploy**, so it
tracks `main` on its own. Verified 2026-07-05 right after PR #12: `two560-app.onrender.com/health`
returned `1.3.4 @ 3e4ab1a`, identical to the primary, with the hook still unset. The hook would
only be redundant "double insurance" if native auto-deploy ever failed or got disabled. Per
`deploy-sync.yml`'s own comment: only atungc2020 (a public-repo fork with no auto-deploy) *needs*
its hook; schienbiz's is belt-and-suspenders.

**Decision (2026-07-05):** left unset by choice — native auto-deploy keeps the standby current.
Revisit only if the standby is ever observed lagging the primary's `/health` sha.

**How, if ever wanted:** copy the Deploy Hook URL from Render (two560-app → Settings → Deploy
Hook) and `gh secret set RENDER_HOOK_SCHIENBIZ --body '<url>'`. It's a capability URL — keep it
out of chat/logs.

---

## TW live quote (TWSE) and history (Yahoo) come from different sources

**What:** For Taiwan stocks, the real-time price uses TWSE (`yahoo.ts:_twseQuote`) while the
OHLCV history that MAs are computed from uses Yahoo. The displayed current price and the last MA
point therefore come from two feeds that can disagree slightly (Yahoo TW data is often delayed
or adjusted differently).

**Why:** A user can see a live price that doesn't line up with where the MA25 line sits, which
looks like a bug even though both are individually correct. Cross detection itself is unaffected
(the nightly scan uses Yahoo closes consistently) — this is a display-consistency gap only.

**Pros:** Live price and MA history come from one coherent source.
**Cons:** TWSE has no long daily history endpoint here; unifying means either backfilling history
from TWSE or accepting Yahoo for the live price too (losing the broker-grade real-time quote).

**Context:** Found during the 2026-07-03 precision audit. Cosmetic; lowest priority of the batch.
Reviewed again 2026-07-05 (#5 of the precision batch): confirmed display-only — no signal path
touches the live quote — so deliberately NOT fixed. Kept as a documented known behavior.

**Depends on:** Nothing hard. Revisit if users report price/MA mismatch confusion.

---

## HK symbols are scanned on a forming intraday bar

**What:** `scan-tw.yml` fires at 06:00 UTC (14:00 HKT) but HKEX trades until 16:00 HKT, and the
Yahoo adapter keeps the in-progress bar (unlike Kraken, which drops uncommitted candles). So for
`.HK` symbols, cross detection AND the new strong-death factor scoring run against a bar that is
still forming — the 「settled closes」 contract holds for TW (closed 13:30 local) and crypto, but
not HK.

**Why:** A cross detected at 14:00 HKT can un-cross by the 16:00 close; the notification is
already sent. Pre-existing behavior for cross detection (not introduced by the strong-death
feature), inherited by the 5-factor scoring.

Related: the strong-death market-regime factor judges `.HK` symbols against 0050.TW (the "tw"
bucket index), but HK stocks track HSI, not Taiwan. A date mismatch (HK trading on a TW
holiday) now safely degrades to 資料不足, but on normal days the factor reflects the wrong
market. If `.HK` symbols become a real use case, add `^HSI` (Yahoo) as the hk bucket index.

**Fix sketch:** Either move `.HK` to a post-08:00-UTC schedule (separate cron or fold into
scan-us pre-market), or drop a today-dated `.HK` bar at scan time when the scan runs before
08:00 UTC.

**Priority:** P2 — only matters if `.HK` symbols are actually on the watchlist.

**Context:** Found by red-team review during v1.4.0 ship (2026-07-08).

---

## Scan curl --max-time headroom on heavy death-cross days

**What:** `/internal/scan` responds only after the full scan completes, and the GitHub Actions
curl uses `--max-time 90`. The strong-death evaluation adds deep fetches + up to 32 sequential
Neon upsert batches per unique symbol/index on exactly the days with many simultaneous death
crosses (market crashes). If total scan time crosses 90s, the workflow fires a false 「後端可能
掛了」 Telegram alert even though the scan finishes server-side.

**Why:** False alarms on crash days erode trust in the dead-man alert. Mitigated substantially by
the promise memo (one index fetch per market bucket per scan) but not eliminated.

**Fix sketch:** Raise `--max-time` to 240 (cheap), or make `/internal/scan` respond 202 and push
a completion heartbeat (proper, but changes the dead-man semantics — see monitoring lessons in
memory before touching this).

**Priority:** ~~P2~~ — ✅ **DONE 2026-09-07 (v1.7.0).** `--max-time` raised to 240 on all three
scans (and on remind / outcome / morning-summary). The "respond 202 + heartbeat" option was
rejected for exactly the reason this note flagged: `/internal/outcome` and
`/internal/morning-summary` were ALREADY answering before doing the work, and that is precisely
what made their `if: failure()` alerts structurally unable to fire. Both now await and report;
every workflow reads the result body with `jq` instead of trusting the 200.

**Context:** Found by red-team review during v1.4.0 ship (2026-07-08).

---

## First manual A/E pull → Phase 1 (actuarial layer) go/no-go — ✅ 已決策 2026-09-09：NO-GO

**What:** Run `npx tsx scripts/ae-report.ts` (read-only, one command) and read it in two passes:
§1 coverage must be clean (matured crosses all carry 20d outcome + benchmark — if not, fix the
outcome pipeline before interpreting anything), then §2 hit rates vs the backtested expecteds
with Wilson lower bounds. Then decide Phase 1 (assumption register as data + quarterly A/E memo
cron + credibility-blended precision line in notifications, replacing the static 「回測83%」).

**Trigger (whichever comes first):** 2026-10-15, or §1 shows ≥20 matured crosses. Accrual is
~3–4 crosses/month across the current watchlist, so mid-October ≈ 15–20 matured signals.

**Decision criteria, written down now so October-me doesn't rationalize:**
- Phase 1 **worth building** if: the manual pull took real effort / got skipped past its trigger
  date (automation exists to defeat forgetting), OR §2 already shows a tier drifting from its
  expected (a live calibration consumer exists), OR strong-death 5/5 signals started appearing
  (the 83% line in notifications is then quoting a number with zero live samples behind it).
- Phase 1 **not worth building** if: the script takes <5 min quarterly and its numbers don't
  change any decision — a calendar entry + this script may simply be Phase 1 forever. That is
  a legitimate outcome, not a failure.

**Why:** Phase 0 (v1.5.0, `c84822c`) made outcomes/benchmarks/strong-tier accrue correctly, but
n is tiny (9 crosses since 2026-04-23) — tier-level cells need 12–18 months for n≥20, so building
the memo cron now would automate the reporting of noise. The known failure mode of "wait and
see" is that nobody comes back (stale-aggregate/彙總標題過期 lesson) — hence the dated trigger,
the zero-friction script, and criteria fixed in advance.

**Depends on:** outcome pipeline staying healthy while waiting — guarded by `outcome.yml`
`if: failure()` Telegram alert (4a69ff7) and the audit script's workflow tracking. §1 of the
report is the backstop check at pull time.

**⚠️ Update 2026-09-07 — the trigger fired on 09-02 and §1 was NOT clean; the diagnosis was
wrong, and it is now fixed.** 22 matured crosses but only 10 carried a 20d benchmark. That was
recorded as "not a defect, data availability". It was a defect: nothing in the system kept the
benchmark index series current. Index bars only ever arrived as a side effect of
`evaluateStrongDeath()`, which runs solely on a bar where a death cross fires — so SPY froze at
2026-07-21 and 0050.TW at 2026-08-14, and every cross missing `benchmark_20d` sat after its own
index's last bar, an exact match. v1.7.0 has `runOutcome()` refresh all three indexes daily
before the fill loop, and the 19 affected rows are all inside `STALE_AGE_DAYS` so they will
backfill on the next runs rather than aging out.

**Re-read §1 after two or three outcome runs post-deploy**, then take the go/no-go decision
against the criteria above — this time on clean coverage. Note that the canonical-symbol merge
also removes ~6 duplicate cross rows (2330 was counted as two stocks), so the matured-cross
count will drop slightly and that drop is a correction, not a regression.

### ✅ 決策已作成 2026-09-09：**Phase 1 NO-GO**（不建 actuarial layer）

在 v1.7.6（`fbfa72f`）部署後、outcome cron 連續 6 次成功之下重跑。**三個「值得建」條件全部不成立**：

| 預寫條件 | 實測 | 判定 |
|---|---|---|
| 手動拉取費力／錯過觸發日 | `time npx tsx scripts/ae-report.ts` = **3.5 秒**；觸發日 10-15 未到，09-02 提早觸發後已連拉四次，沒有被遺忘 | ❌ 不成立 |
| §2 已有 tier 偏離期望值 | **沒有任何一格的 95% Wilson 區間排除其期望值**：death all 6/9=67% CI[35%,88%] vs 52%（binom p=0.51）、golden all 6/13=46% CI[23%,71%] vs 54%（p=0.59）、death ≥4/5 1/1 CI[21%,100%] vs 72%（p=1.00） | ❌ 不成立 |
| 強確認死叉 5/5 開始出現 | **n=0**。9 次死叉的強確認分佈上限是 4/5，且 4/5 只有 1 筆 | ❌ 不成立 |

「不值得建」條件成立：腳本 3.5 秒、每一格都是「資料不足」、沒有任何數字改變任何決策。
**Phase 1 就是「一個行事曆提醒 + 這支腳本」，這是當初就寫明的正當結果，不是失敗。**

**§1 覆蓋首次全 horizon 乾淨**（不只 20d）：5d 22/22、10d 21/21、20d 17/17（此為決策當下
以 12／17／28 天到期線量得；同日稍後到期線改由 `coverageMatureDays()` 推導為 12／19／33，
報表現讀 5d 19/19、10d 18/18、20d 13/13 —— 更保守，結論不變，仍是零缺口），outcome 與
benchmark 皆零缺口；無重複列、無裸 4 碼（canonical 合併守住了）；17 檔不重複標的。

#### ⚠️ 但這次分析推翻了「再等就會有答案」這個前提

實測累積速率（觀測期 4.6 個月、27 次交叉、5.9 次/月）：

| cell | n | 速率 | 距 n=20 |
|---|---|---|---|
| golden all | 18 | 3.93/月 | **~1 個月** |
| death all | 9 | 1.97/月 | ~6 個月 |
| death ≥4/5 | 1 | 0.22/月 | **87 個月（7.2 年）** |
| death 5/5 | 0 | **0/月** | **永不** |

原本的計畫寫「tier 級別的格子需要 12–18 個月才能 n≥20」。**實測是 87 個月與「永不」。**
所以「等到 n≥20 再判」對於**唯一有引用統計數字的兩個 tier** 是一個永遠達不到的里程碑
（[[feedback_threshold_beyond_retention.md]] 同型：閾值訂在不可達處，門永遠不會響）。

而唯一會在一兩個月內達標的 `golden all`，**在產品裡沒有引用任何精準度數字** —— 也就是說，
第一個真正有統計意義的 A/E 判定，會落在最不影響決策的那一格。

#### 三項後續 —— ✅ 全部已修（2026-09-09，同日）

1. ✅ **觸發條件已改成可達的。** `RETRIGGER_DATE = 2026-12-15` **或** death 5/5 首次出現
   （n≥1）—— 後者才是真正會改變決策的事件（83% 那行第一次被送出的時刻）。報表新增 §3
   直接印出兩個條件的當下狀態，不必靠人記得判準。
2. ✅ **`MIN_CELL_N = 20` 已由檢定力判定取代**（`src/utils/ae-stats.ts`）。判定不再看 n 的
   門檻，而是看 **95% Wilson 區間有沒有真的排除期望值**：排除 → 偏離；涵蓋且 n 已足以偵測
   帶邊 → 一致；否則 → 資料不足，並直接印出還需要多少 n。

   ⚠️ **更正先前記錄的數字。** 09-09 初版用 `round(target×n)` 取整估算，那是捨入假象且
   **對 n 不單調**：p0=0.83 低側「n≈6」成立，但 n=7、8、10 反而不成立。改用精確比例後的
   正確值是 —— death all **n≈40**、golden all **n≈37**、death ≥4/5 **n≈17**、
   death 5/5 低側 **n≈9**（先前記為 35／35／17／6）。已加測試釘住單調性。
   **高側仍然不可達**：0.83×1.3=1.079>1，對稱帶對高期望值的格子根本不適用。
3. ✅ **§1 現在檢查 5d／10d／20d 三個 horizon**，各用自己的到期規則，並分別列出缺值的列。

   順帶修掉兩個同源缺陷：(a) 舊的 20d 到期線是 `age > 28`（名目窗口），但值是「+28d 當日或
   之後的第一根 K 棒」，而 `WINDOW_END_CAL_DAYS = 33` 的存在正是因為那根 K 棒可能晚到
   +33d —— 所以 29–33 天的列會被誤報成「已到期卻缺值」。到期線改由
   `coverageMatureDays()` 從 `WINDOW_END_CAL_DAYS - WINDOW_CAL_DAYS.d20 = 5` 天 slack 推導，
   非任意值。這個閘門已經狼來了兩次（09-02、09-08），其中一次假警報被當成「資料可得性」
   放行，底下藏著真缺陷。(b) 超過 `STALE_AGE_DAYS`(120) 的列 cron 已放棄，另外計數，
   否則會變成永久警告 → 永久被忽略。

   `ELIGIBLE_AGE_DAYS` / `STALE_AGE_DAYS` 已移進 `outcome-math.ts`，cron 與報表共用同一份，
   避免兩份常數漂移。

**測試：** `tests/ae-stats.test.ts` 32 個測試、**13/13 突變被殺、no-op 對照組存活**，並手動
套一個突變確認是真斷言失敗（1 個具名測試失敗、31 個仍通過）。期望值取自解析恆等式而非錄製
輸出 —— 包含 Wilson 的**定義式**（區間端點滿足 (p̂−p)² = z²·p(1−p)/n）。這一條是必要的：
突變測試顯示「margin 少除以 denom」能同時通過對稱性、包含點估計、隨 n 收窄三個性質測試，
只有定義式抓得到。過程中還發現 `wilsonIntervalFromRate` 的 `n<=0` 守衛是**不可達死碼**
（`wilsonInterval` 自己有一份重複的），已改為只留一份。

**「回測5日精準度83%」這行從來沒有被送出過** —— 已查證 `isStrong = applicable===5 && passed===5`，
而庫裡 5/5 是 0 筆。所以目前沒有「拿零樣本的數字對使用者說話」這個活的問題，
criterion (c) 擔心的情境尚未發生。


---

## Deferred from the 2026-09-07 exhaustive review — CLEARED in v1.7.6 (2026-09-09)

All seven items that review left deferred are now done. Kept here as a record of what was
decided and why, not as outstanding work.

- ✅ **`engine/structure.ts` used `[...ma25].reverse().find(...)`** → now `lastNonNull()`, matching
  the Round-6 rewrite that had missed this one call site. Pure allocation, no behaviour change.
- ✅ **`src/auth.ts` compared the Telegram initData HMAC with `!==`** → now `timingSafeEqual` with
  the length guard it requires (it throws on differing lengths). This was the last secret
  comparison in the codebase not hardened by `25cc284`.
- ✅ **`routes/signals.ts` returned `{signals: []}` from its catch** → now HTTP 500. A DB fault
  used to be indistinguishable from "you have no signals". Checked both callers before changing:
  `reminders.js` renders 「載入失敗，請稍後再試」 and `stats.js` omits the section — both already
  had catch blocks, so no UI work was needed and the decision that was blocking this turned out
  to be already made.
- ✅ **`/pulse` showed a cached close with no as-of date** → each row now prints 「收盤 YYYY-MM-DD」
  under the price. This is the minimum viable fix only. **Still open:** a live-quote overlay on
  `/pulse`, which needs a rate-limit story first because the page is unauthenticated.
- ✅ **A reminder whose push failed was lost** → fixed in v1.7.5 (3-day grace window, delivery
  labelled 「原訂 …，補送」, older rows expired via `expired_at` rather than a lying `sent:true`).
- ✅ **The public chart/backtest routes re-probed Yahoo for every nonexistent code** →
  `resolveTwSuffix` now returns `definitivelyAbsent`, and `resolveSymbol` memoises a confirmed
  absence as well as a confirmed listing. An *inconclusive* probe is still never memoised, so a
  Yahoo outage cannot pin a wrong answer until the next deploy. **Still open:** rate-limiting the
  public routes; they remain an unauthenticated proxy, now with a bounded miss cost.
- ✅ **`engine/indicators.ts`, `src/auth.ts` and both webhook handlers had no test file** →
  `tests/indicators.test.ts` (18), `tests/auth.test.ts` (19), `tests/webhooks.test.ts` (17).
  13/13 mutants killed, no-op mutant survived. Two fail-open behaviours are now *pinned* rather
  than changed, because both are load-bearing and neither is currently exposed:
  the `Bearer dev` backdoor is open whenever `NODE_ENV` is unset, and the Telegram webhook is
  open whenever `TELEGRAM_WEBHOOK_SECRET` is unset.

  ⚠️ **Do not verify the first one from the Render dashboard.** `GET /v1/services/:id/env-vars`
  reports `NODE_ENV` as absent on `two560-app-2` (the live backend), because that endpoint
  returns only user-defined variables while Render injects `NODE_ENV=production` for a Node
  service at runtime. Reading the dashboard alone gives exactly the wrong answer. Verified
  behaviourally instead on 2026-09-09:
  `curl -H 'Authorization: Bearer dev' https://two560-app.atungc2020.workers.dev/api/watchlist`
  → **401**. Both backends do set `TELEGRAM_WEBHOOK_SECRET` (48 chars, checked via the API).

### Still open from the above

- A live-quote overlay on `/pulse` (needs a rate-limit story; the page is unauthenticated).
- Rate-limiting the public chart/backtest routes.
- `src/auth.ts`'s LINE token cache is still an unbounded `Map` with an hourly sweep — see the
  LRU item earlier in this file. One user, so it is not a live risk.

---

## Backtest reporting quirks, surfaced by writing its tests (2026-09-08)

Behaviour that is now pinned by `tests/backtest.test.ts` rather than fixed, because each one
changes numbers the user has already seen and is therefore a product call:

- **`profit_factor: null` and `expectancy: null` each mean two different things.** A strategy
  with no losing trade has an infinite profit factor, which is mapped to `null` — the same value
  returned when there were no trades at all. `expectancy` is `null` whenever either side is
  empty, likewise. A caller cannot distinguish a flawless run from an empty one. Fix sketch:
  return a discriminated value (`"undefined" | number`), or add an explicit `trade_count` check
  in the UI before rendering the cell.
- **A backtest can miss one cross the live scanner would take.** The loop starts at
  `slowPeriod + 1` so the transition at index `slowPeriod` is never examined — it is the
  MA-initialisation artefact guard, now explained in the source. Changing it moves every
  historical backtest number.
- **`by_confidence` grades a short-history cross lower than the live app does.** `scoreSignal`
  drops a factor with no history (RSI needs 15 bars, MACD 34) from the denominator; the backtest
  scores it `false`, a plain failure. With the default 25/60 the loop never starts before bar 61
  so all four always apply and the two agree — it only bites the custom periods the route
  permits (`slow_period` as low as 3). It matters because `by_confidence` is read as "how do
  high-confidence signals perform", and "high" is not the same word in both places.
- **`by_confidence` counts only CLOSED trades**, so an open position's confidence appears in no
  bucket. Correct for hit-rate maths, but the counts do not add up to the signals shown.

---

## Completed

### Precision: settled-only daily bars (crypto) + intraday cache TTL (stock)
**Completed:** v1.3.4 (2026-07-05)

Batch items #3 and #4 from the 2026-07-03/05 precision audit.
- **#4 crypto in-progress candle**: `normalizeKrakenBars` (`binance.ts`) now drops any candle
  past Kraken's `result.last` (the last *committed* candle marker), so MA/cross detection use
  settled UTC-day closes only. Confirmed via live Kraken: the 01:00 UTC crypto scan had been
  evaluating a ~1-hour-old forming candle. Chart shows settled candles + live price overlay.
- **#3 stock intraday cache freeze**: `isCacheStale` (`cache.ts`) gives a today-dated stock bar
  a 30-minute TTL instead of freezing it until 08:00 UTC next day, so interactive reads during
  market hours refresh the forming bar. Settled past days keep the overnight buffer.
Tested: `kraken-normalize` (4) + `cache-stale` (6).

### Precision: thin-history signal guard + Yahoo partial-bar backfill
**Completed:** v1.3.3 (2026-07-03)

Batch items #1 and #2. `hasSufficientBars` gate on chart/scan/ws/ai (no phantom cross on
under-provisioned cache); `normalizeYahooBars` backfills null/non-positive OHLC from close
(no phantom-0 support / ATR spike). See CHANGELOG v1.3.3.

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
