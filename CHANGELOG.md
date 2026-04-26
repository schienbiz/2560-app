# Changelog

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
