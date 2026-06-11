import { Hono } from "hono"
import { db }   from "../db.js"

const app = new Hono()

// ─── Types ────────────────────────────────────────────────────────────────────

interface PulseRow {
  symbol:      string
  signalLabel: string
  count:       number
  close:       string
}

// ─── In-memory cache (60s TTL) ───────────────────────────────────────────────

let pulseCache: { data: PulseRow[]; ts: number } | null = null
const CACHE_TTL = 60_000

// ─── Signal label map ─────────────────────────────────────────────────────────

function signalLabel(signal: string | null | undefined): string {
  switch (signal) {
    case "golden_cross":     return "🟢 黃金交叉"
    case "death_cross":      return "🔴 死亡交叉"
    case "proximity_golden": return "📍 接近進場區"
    case "proximity_exit":   return "📍 接近出場區"
    case "none":             return "─ 觀察中"
    default:                 return "─ 無資料"
  }
}

// ─── Data fetch ───────────────────────────────────────────────────────────────

async function fetchPulseData(): Promise<PulseRow[]> {
  // Fetch all watchlist entries that have an active alert
  const watchlists = await db.watchlist.findMany({
    where:  { alert: { active: true } },
    select: { symbol: true },
  })

  // Count watchers per symbol in memory
  const countMap = new Map<string, number>()
  for (const w of watchlists) {
    countMap.set(w.symbol, (countMap.get(w.symbol) ?? 0) + 1)
  }

  // Only show symbols with ≥2 watchers, sorted descending
  const qualified = [...countMap.entries()]
    .filter(([, n]) => n >= 2)
    .sort(([, a], [, b]) => b - a)

  if (qualified.length === 0) return []

  const symbols = qualified.map(([s]) => s)

  // 2 queries total instead of 2N — fetch latest signal and price for all symbols at once
  const [latestSignals, latestPrices] = await Promise.all([
    db.signalHistory.findMany({
      where:    { symbol: { in: symbols } },
      orderBy:  { signal_date: "desc" },
      distinct: ["symbol"],
    }),
    db.ohlcvCache.findMany({
      where:    { symbol: { in: symbols } },
      orderBy:  { date: "desc" },
      distinct: ["symbol"],
    }),
  ])

  const signalMap = new Map(latestSignals.map(s => [s.symbol, s]))
  const priceMap  = new Map(latestPrices.map(p => [p.symbol, p]))

  const rows: PulseRow[] = qualified.map(([symbol, count]) => {
    const sig   = signalMap.get(symbol)
    const ohlcv = priceMap.get(symbol)
    const close = ohlcv?.close != null ? ohlcv.close.toLocaleString("zh-TW") : "─"
    return { symbol, signalLabel: signalLabel(sig?.signal), count, close }
  })

  return rows
}

// ─── Share button JS ──────────────────────────────────────────────────────────

const shareScript = /* html */`
<script>
async function shareSymbol(symbol, signal, count) {
  const text = \`我在用2560信號雷達追蹤\${symbol}，目前\${signal}，有\${count}位朋友也在追！\\nhttps://two560-app.onrender.com/pulse\`
  if (navigator.share) {
    try { await navigator.share({ text }); return } catch (e) { /* user cancelled */ }
  }
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    const toast = document.getElementById('toast')
    if (toast) { toast.style.display = 'block'; setTimeout(() => { toast.style.display = 'none' }, 2000) }
  }
}
</script>
`

// ─── HTML template ────────────────────────────────────────────────────────────

function renderPage(rows: PulseRow[]): string {
  const tableRows = rows.length === 0
    ? `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:2rem 0">訊號資料每日收盤後更新，稍後再來看看。</td></tr>`
    : rows.map(r => /* html */`
    <tr>
      <td style="font-weight:600">${escapeHtml(r.symbol)}</td>
      <td>${r.signalLabel}</td>
      <td>👥 ${r.count} 人</td>
      <td style="text-align:right">${escapeHtml(r.close)}</td>
      <td style="text-align:center">
        <button onclick="shareSymbol('${escapeHtml(r.symbol)}','${r.signalLabel}',${r.count})"
          style="background:none;border:1px solid var(--muted);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:0.8rem;color:var(--muted)">
          分享
        </button>
      </td>
    </tr>`).join("\n")

  return /* html */`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>2560信號雷達</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg: #0d1117; --surface: #161b22; --border: #30363d;
      --text: #e6edf3; --muted: #7d8590; --green: #3fb950;
      --red: #f85149; --yellow: #d29922; --blue: #388bfd;
    }
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 1.5rem 1rem; max-width: 640px; margin: 0 auto }
    h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 0.25rem }
    .subtitle { color: var(--muted); font-size: 0.9rem; margin-bottom: 1.5rem }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem }
    th { color: var(--muted); font-weight: 500; text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border) }
    td { padding: 0.6rem 0.5rem; border-bottom: 1px solid var(--border) }
    .cta { margin-top: 2rem; padding: 1rem; background: var(--surface); border-radius: 12px; border: 1px solid var(--border) }
    .cta p { color: var(--muted); font-size: 0.9rem; margin-bottom: 0.75rem }
    .btn-row { display: flex; gap: 0.75rem; flex-wrap: wrap }
    .btn { display: inline-block; padding: 0.5rem 1rem; border-radius: 8px; font-size: 0.9rem; text-decoration: none; font-weight: 500; border: none; cursor: pointer }
    .btn-line { background: #06c755; color: #fff }
    .btn-tg   { background: #2aabee; color: #fff }
    #toast { display: none; position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%);
      background: #333; color: #fff; padding: 0.5rem 1.2rem; border-radius: 8px; font-size: 0.85rem }
    @media (max-width: 400px) { h1 { font-size: 1.3rem } }
  </style>
</head>
<body>
  <h1>2560信號雷達</h1>
  <p class="subtitle">追蹤 2560戰法（MA25/MA60）的熱門標的</p>

  <table>
    <thead>
      <tr>
        <th>標的</th>
        <th>訊號狀態</th>
        <th>追蹤人數</th>
        <th style="text-align:right">收盤</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>

  <div class="cta">
    <p>想收到這些標的的即時訊號通知？</p>
    <div class="btn-row">
      <button class="btn btn-line" onclick="openLink('https://line.me/R/ti/p/@2560signal', false)">加入 LINE 機器人</button>
      <button class="btn btn-tg"   onclick="openLink('https://t.me/two560_bot', true)">加入 Telegram</button>
    </div>
  </div>

  <div id="toast">已複製！</div>
  ${shareScript}
  <script>
    var tgApp = window.Telegram && window.Telegram.WebApp;
    if (tgApp) {
      tgApp.ready();
      tgApp.expand();
    }
    function openLink(url, isTg) {
      if (tgApp) {
        if (isTg) {
          tgApp.openTelegramLink(url);
        } else {
          tgApp.openLink(url);
        }
      } else {
        window.open(url, '_blank', 'noopener');
      }
    }
  </script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// ─── Route handler ────────────────────────────────────────────────────────────

app.get("/", async c => {
  c.header("Cache-Control", "public, max-age=60")

  // Serve from cache if fresh
  if (pulseCache && Date.now() - pulseCache.ts < CACHE_TTL) {
    return c.html(renderPage(pulseCache.data))
  }

  try {
    const data = await fetchPulseData()
    pulseCache = { data, ts: Date.now() }
    return c.html(renderPage(data))
  } catch (err) {
    console.error("Pulse route error:", err)
    // Stale cache beats error page
    if (pulseCache) return c.html(renderPage(pulseCache.data))
    return c.html(renderPage([]))
  }
})

export { app as pulseRouter }
