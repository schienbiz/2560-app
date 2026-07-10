# Changelog

## [1.5.0] — 2026-07-10

### Fixed
- **Outcome cron no longer one-shot — outcome_10d/20d were permanently null**: eligibility was
  keyed on `outcome_computed_at: null` and rows became eligible at +10 calendar days, when only
  the 5d window had matured — the stamp then excluded them forever, so every historical row had
  10d/20d = null (verified in production: RDW 2026-04-23 still null at +77 days). Eligibility is
  now data-driven (any golden/death cross aged 10–120 days whose 20d outcome or benchmark is
  missing), each pass fills only fields that are still null and never overwrites a stored value,
  and rows older than 120 days keep whatever they have so a delisted symbol isn't re-scanned
  daily forever. All 7 mature production rows backfilled and verified.

### Added
- **Strong-death score persisted per signal** (`strong_passed`/`strong_applicable` on
  `SignalHistory`): the 5-factor count was computed for the notification and then thrown away,
  which made the backtested 83% claim unverifiable against live experience — there was no record
  of which death crosses fired at which tier. The scan now persists the score at signal time;
  the 5 historical death crosses were backfilled best-effort by re-scoring today's bars truncated
  to each cross bar (PYPL 4/5, NI 3/5, LUNR 3/5, LEU 2/5, 2308.TW 2/5).
- **Market-benchmark outcomes** (`benchmark_5d/10d/20d`): the regime index return (BTC / SPY /
  0050.TW per market bucket, same mapping as the strong-death market factor) over the same
  windows as each signal's outcome. Raw outcome alone conflates "the signal worked" with "the
  whole market moved" — a death cross looks broken in a rally and prescient in a crash; the
  benchmark column is what lets future signal stats separate the two. Base = index close at (or
  first trading day after) the signal date, null on a >5-day cache gap rather than fabricated
  from a late base.
- Pure window math extracted to `src/utils/outcome-math.ts` (`getMarket` moved to
  `src/utils/strong-death.ts`, re-exported from scan); 12 new tests cover window targeting,
  holiday/gap handling, benchmark routing, null-preservation on re-passes, and batch isolation.

## [1.4.1] — 2026-07-09

### Fixed
- **Deep-history write-back no longer stalls the scan**: post-deploy audit dry-ran today's real
  death cross (2308.TW) through the production path and caught the strong-death cache write-back
  taking minutes — `upsertOHLCV` issues one round trip per bar (~500 sequential queries for a
  2-year series), measured 75× slower than a single bulk statement against production Neon. Deep
  backfill now uses `bulkInsertOHLCV` (one `createMany … skipDuplicates`); historical bars are
  immutable so insert-or-skip semantics are exact, and the shallow scan path keeps refreshing the
  newest bars via upsert. Without this, a multi-death-cross day could delay notifications by
  minutes per symbol and trip the workflow dead-man alert.

## [1.4.0] — 2026-07-08

### Added
- **強確認死叉 (5-factor strong-confirmation death cross)**: death-cross notifications now carry a
  confirmation score checking five bearish factors at the cross bar — Vegas tunnel bearish
  alignment (EMA144 < EMA169), MACD histogram < 0, slow-MA 5-bar slope down, RSI(14) in 35–50,
  and the market index (BTC for crypto, SPY for US, 0050.TW for TW/HK) at or below its MA200.
  All five pass → `⚡ 強確認死叉 5/5`; otherwise `死叉確認 X/5` with the failed factors listed,
  and missing history reported as 資料不足 rather than counted as a failure (fail-closed: a cross
  can only be "strong" when all five factors are computable and pass). The 83% precision claim
  is only shown for alerts on the backtested MA25/60 pair — custom-period alerts get the
  confirmation count without the unvalidated statistic. Golden crosses are deliberately left
  unfiltered — backtests show their value is in return magnitude, not directional precision.
  - Evidence (16 symbols × ~9y daily, 577 crosses, time-split validated train <2024 / test ≥2024):
    5/5-confirmed death crosses showed ~83% 5-day precision (n=23) vs 52% for all death crosses;
    precision rises monotonically with factor count (36→47→40→62→66→83%), ≥4 factors held 78%
    in the out-of-sample period. Small n — treat as strong evidence, not a guarantee.
  - Implementation: pure scoring in `src/engine/strong-death.ts`; fetch orchestration in
    `src/utils/strong-death.ts` pulls ~2 years of deep history lazily, only on the bar where a
    death cross actually fires — deep enough that EMA169 is converged like the backtest's (at
    ~250 bars the EMA seed still carries ~38% of the value), reading the DB cache directly (the
    shared in-process OHLCV cache would serve/memorize shallow 90-day windows and the deep
    factors would silently never compute) with adapter fallback, deduped through a promise memo
    so a symbol that is also the market index (BTC/SPY/0050) shares one fetch. All series are
    date-aligned to the cross bar: factors are never scored on yesterday's close, and a market
    index lagging the cross bar (e.g. an HK cross on a TW holiday) degrades to 資料不足 instead
    of silently using a stale close. Runs concurrently with the AI insight call, and any data
    failure degrades to the plain notification (never blocks it).

### Fixed
- **Taiwan-market crosses can no longer be silently dropped by the cache freshness window**:
  the settled-day OHLCV cache rule ("fresh until 08:00 UTC the day after fetch") outlived the
  06:00 UTC scan-tw schedule, so a series fetched by yesterday's scan was still served to
  today's scan — the scan scored yesterday's bars, and because cross detection only fires on
  the last bar transition, a cross landing on today's bar was permanently missed once the next
  day's refetch moved past it. The horizon (DB cache and the in-process mirror) is now the NEXT
  05:30 UTC after the fetch, expiring just before the earliest daily scan; overnight consumers
  (morning summary 00:00 UTC, reminders 00:30 UTC) keep riding the buffer. Regression-tested
  against the exact scan-timing scenario.

## [1.3.4] — 2026-07-05

### Fixed
- **Crypto crosses now fire on settled daily closes, not the forming candle**: Kraken returns the
  current, not-yet-closed UTC-day candle as the last OHLC row. The daily crypto scan (01:00 UTC)
  was detecting crosses on a candle barely an hour old (~⅓ of a day's volume), and the chart's
  last MA point jittered intraday. `normalizeKrakenBars` now drops any candle past Kraken's own
  `result.last` (last-committed marker), so MA and cross detection see settled closes only. The
  live price is still shown via the quote overlay. Verified against live Kraken data.
- **Stock chart no longer freezes an intraday price for hours**: `isCacheStale` kept a stock bar
  dated *today* fresh until 08:00 UTC the next day, so a chart opened mid-session pinned that
  moment's price as the last MA point through the real close. Today-dated stock bars now get a
  30-minute TTL (settled past days keep the overnight buffer), so interactive reads refresh the
  forming bar. The nightly scan was already correct (it runs post-close).

## [1.3.3] — 2026-07-03

### Fixed
- **Interactive/live surfaces now suppress signals on thin history**: the chart, scan, WebSocket,
  and AI-analysis routes computed a signal even when there weren't enough bars for the slow MA to
  settle. Combined with the cache returning as few as `min(days, 60)` rows, a large `slow_period`
  on a thinly-cached or freshly-listed symbol could show a phantom cross off the just-initialized
  MA. All four now gate on a shared `hasSufficientBars(barCount, slowPeriod)` (`slow_period + 5`)
  and return `signal: none` + `insufficient_history: true` instead. The cron scan, backtest, and
  morning-summary already had this guard inline; they now share the same helper so the rule lives
  in one place.
- **Yahoo partial bars no longer corrupt high/low**: `normalizeYahooBars` used `high ?? 0` /
  `low ?? 0`, so a bar with a valid close but null high/low was kept as `high=0, low=0`. That put
  a phantom support level at price 0 (`sr.ts`) and blew up ATR (`structure.ts`). Bars with no
  usable close are now dropped, and a missing or non-positive open/high/low is backfilled from the
  close (a doji), keeping the close series intact for MAs while fixing the downstream math.

## [1.3.2] — 2026-07-03

### Added
- **Deploy verifiability**: `/health` now reports `version` (from `package.json`) and
  `sha` (the running commit, from Render's `RENDER_GIT_COMMIT`, 7 chars; `dev` locally).
  Previously `/health` returned only `{ok, service}`, so a deploy couldn't be confirmed
  from outside — a `200` proved the service was up but not which commit was serving.

## [1.3.1] — 2026-07-02

### Fixed
- **Signal confidence no longer under-scores short-history symbols**: `scoreSignal`
  now computes confidence as the fraction of *applicable* factors that pass
  (`passed / applicable`) rather than a raw count out of 4. RSI needs ≥15 bars and
  MACD needs ≥34 bars, so on small custom MA pairs (`slow_period` can be as low as 3)
  or freshly-listed symbols those factors have no data — previously they were counted
  as failures, systematically capping an otherwise strong cross at `medium`/`low`.
  With full history all four factors apply and the thresholds reduce exactly to the
  original `3+→high / 2→medium / ≤1→low`, so established symbols are unchanged. `high`
  additionally requires ≥2 applicable factors, so a lone surviving factor (e.g. a
  zero-volume symbol where only proximity applies) can't reach top confidence on 1/1.

### Added
- **CI unit-test gate** (`.github/workflows/test.yml`): runs `tsc --noEmit` + `vitest`
  on every push/PR to `main`. Previously no workflow ran the test suite, so a stale
  `signal.test.ts` (left on the 2-factor model after the engine moved to 4 factors)
  failed silently. Also refreshed the `scoreSignal` tests to cover the applicable-ratio
  model for both short and full history.

## [1.3.0] — 2026-04-27

### Added
- **Signal Pulse public page** (`/pulse`): a public, no-login page showing the top-watched
  symbols across all app users, their current MA25/MA60 signal status, watcher count, and
  latest closing price. Requires ≥2 watchers per symbol to appear (privacy threshold). Updates
  live on each request with a 60-second server-side cache and `Cache-Control: public, max-age=60`.
- **Share button per symbol row**: tap 分享 to send a pre-written LINE message via
  `navigator.share()`, with clipboard fallback and a "已複製！" toast for older browsers.
- **UTM acquisition tracking**: LINE and Telegram CTA links carry `?ref=ptt` and `?ref=line`
  params so you can measure which channel drives signups after posting on PTT or LINE groups.

## [1.2.0] — 2026-04-26

### Added
- **Swing point markers on chart**: the chart now shows the last 4 swing structure
  points (HH = Higher High, HL = Higher Low, LH = Lower High, LL = Lower Low) as
  colored arrows. Tap the "擺動結構" toggle button to show/hide. Uptrend structure
  (HH/HL chain) shows in green; downtrend (LH/LL chain) in red. A legend inside the
  analysis card explains the notation.
- **Signal outcome tracking**: each golden/death cross in the alert history now shows
  its actual % return at 5, 10, and 20 trading days after the signal. While the result
  is being calculated, a "結果計算中" note appears. A daily GitHub Actions cron job
  (`outcome.yml`) computes outcomes automatically and writes them back to the database.
- **Per-symbol proximity threshold**: the proximity alert (how close price must get to
  MA25 to trigger) is now configurable per symbol. Open the settings sheet from the
  watchlist and use the slider (0.5% – 10%). Shows a live hint in absolute price terms
  (e.g., "目前等於 MA25 185.00 ± 2.78"). The slider is disabled when golden cross
  notifications are off since proximity alerts only apply to the golden cross flow.
- **Price action structure engine** (`src/engine/structure.ts`): detects pivot highs/lows,
  labels swing structure (HH/HL/LH/LL), classifies trend phase (impulse_up,
  impulse_down, correction, range), computes ATR(14), and determines bias
  (bullish/bearish/neutral). Used to ground the 5-point AI analysis in actual price
  structure rather than only MA crossover wording.

### Changed
- **AI analysis upgraded to structured 5-point format**: the Groq prompt now receives
  recent 15 candles, swing structure, and current trend phase, producing five distinct
  analysis points per symbol.
- **Design system additions**: new `.badge-compact` CSS class for dense inline badges;
  cross-browser range slider styling (`-webkit-slider-thumb`, `-moz-range-thumb`).
- **Outcome badge formatting**: badges use consistent `+/-` sign notation and the shared
  `.badge-compact` class rather than ad-hoc inline styles.

## [1.1.2] — 2026-04-24

### Added
- **Real-time price quotes**: prices now update every 10 seconds using live market data.
  Taiwan stocks pull from TWSE `mis.twse.com.tw` (the same source 台新/玉山 Securities
  display) during trading hours, with Yahoo Finance v7 as fallback when the exchange
  is closed. Crypto uses Kraken's Ticker endpoint for live last-trade price. US stocks
  use Yahoo Finance v7 real-time quotes.

### Changed
- **WebSocket update interval**: reduced from 30 s → 10 s for near-real-time price
  refresh. OHLCV history (used for MA25/MA60 calculations) is still cached daily —
  only the displayed price refreshes more frequently.

## [1.1.1] — 2026-04-24

### Added
- **Font size toggle**: tap `A⁻ / A / A⁺` in the watchlist header to cycle 13 px / 14 px / 16 px.
  Your pick persists in localStorage and loads before first paint — no size flash on reload.

### Changed
- **Mobile watchlist layout**: signal badge now stacks above the ⚙ and 移除 buttons on narrow
  screens so rows no longer overflow. Symbol name truncates with ellipsis instead of wrapping.
- **Signal date**: now renders in a block element, giving consistent spacing on all screen widths.

### Fixed
- **Stale 無訊號 badge**: when the server sends `signal: "none"` or any unrecognized value over
  the WebSocket, the badge now resets to 無訊號 rather than keeping the previous cross stale.
- **Symbol ID collisions**: `BTC/USDT` and `BTC_USDT` no longer share a DOM element ID.
  Non-alphanumeric characters are encoded as `_<charCode>_` (e.g. `/` becomes `_47_`),
  so price and signal updates always hit the right row.
- **WebSocket reconnect race**: the pending reconnect timer is cleared at the start of
  `connectWs()`, preventing a dangling timer from closing a freshly-opened connection when
  the watchlist re-renders within 5 s of a disconnect.
- **Font size poisoning**: the raw localStorage value is validated against `["sm","md","lg"]`
  before being written to `document.documentElement.dataset.fs`. Invalid values fall back to
  `"md"` in both the inline head script and `currentFs()`.
- **`signal_date` XSS**: the date string is now escaped before insertion into `innerHTML`,
  consistent with all other server-sourced fields.
- **Font size button null guard**: the `wl-fs-btn` click listener is guarded so it won't throw
  if the container renders in a detached DOM node.

## [1.1.0] — 2026-04-23

### Added
- **Proximity alert**: daily scan now fires when price is within 1.5% of MA25 in a golden cross
  environment (`proximity_golden` signal type)
- **Zone exit alert**: fires when price exits the entry zone (>3% from MA25) after a proximity
  alert in the preceding 3 days (`proximity_exit` signal type)
- **AI-generated cross messages**: golden cross and death cross notifications now include a
  Groq-powered analysis; falls back to raw template on API failure
- **Deep-link in alerts**: all push notifications append a `?symbol=` URL that opens the Chart
  tab directly in the app
- **Morning summary** (`cron/morning-summary.ts`): 8am Taipei time GitHub Actions cron sends a
  filtered AI digest — only symbols with an active cross signal; "all quiet" message when none
- **Alert history UI**: new section in Reminders tab shows last 30 signal events from
  `GET /api/signals`
- **Deep-link routing in app.js**: `?symbol=` query param on page load auto-navigates to Chart
  tab; `history.replaceState` strips the param after processing
- **`GET /api/signals` endpoint**: returns last N signal history entries scoped to the
  authenticated user's watchlist symbols (no user_id on SignalHistory — queries via watchlist)
- **`tests/signals-route.test.ts`**: 7 unit tests for limit-parsing logic (default, clamp, NaN,
  empty, boundary, minimum)

### Migration
- Added `proximity_golden` and `proximity_exit` to `SignalType` enum
- Run: `npx prisma migrate deploy`

### Infrastructure
- `.github/workflows/morning-summary.yml`: new cron workflow (00:00 UTC = 08:00 Taipei)
- `INTERNAL_SECRET` and `APP_URL` GitHub secrets required for morning summary workflow

## [1.0.0] — initial release
