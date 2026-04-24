# Changelog

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
