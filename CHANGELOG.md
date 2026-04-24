# Changelog

## [1.1.1] — 2026-04-24

### Changed
- **Mobile watchlist layout**: signal badge now stacks above ⚙ / 移除 buttons so the row
  never overflows on narrow screens; symbol name truncates with ellipsis instead of wrapping
- **Signal date** (`sigDate`) is now rendered in a `<div>` block element instead of an inline
  `<span>`, giving it consistent spacing on all screen widths

### Added
- **Font size toggle**: `A⁻ / A / A⁺` button in the watchlist header cycles between 13 px,
  14 px, and 16 px base font size; choice persists in localStorage and applies before first
  render (no flash of unstyled content)

### Fixed
- **"無訊號" not resetting via WebSocket**: when the server sends `signal: "none"` or any
  unrecognised signal value over the live-price WebSocket, the badge now resets to 無訊號
  instead of keeping the previous cross badge stale on screen
- **Symbol ID collisions**: `safeId()` now encodes each non-alphanumeric character as
  `_<charCode>_` (e.g. `/` → `_47_`) so symbols like `BTC/USDT` and `BTC_USDT` no longer
  share the same DOM element ID, preventing price/signal updates targeting the wrong row
- **WebSocket reconnect race**: the pending reconnect `setTimeout` handle is now cleared at
  the start of `connectWs()`, preventing a dangling timer from closing a freshly-opened
  connection when the watchlist re-renders within 5 seconds of a disconnect
- **localStorage font-size injection**: raw `localStorage` value is now validated against the
  `["sm","md","lg"]` allowlist in both the inline head script and `currentFs()` before being
  written to `document.documentElement.dataset.fs`; invalid values fall back to `"md"`
- **`signal_date` XSS**: date string is now passed through `esc()` before insertion into
  `innerHTML`, consistent with all other server-sourced fields
- **Font size button null guard**: `wl-fs-btn` click listener is now guarded so it won't
  throw if the container renders in a detached DOM node

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
