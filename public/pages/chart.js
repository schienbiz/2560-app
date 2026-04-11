/**
 * pages/chart.js — Candlestick chart with MA25/MA60 overlays
 *
 * Uses lightweight-charts v4 (loaded from CDN as global LightweightCharts).
 * Shows the 2560戰法 signal banner, and quick-add-trade / add-reminder buttons.
 */

import { api, ApiError } from "../api.js";
import { showToast, openSheet, closeSheet, navigate } from "../app.js";

let chartInstance = null;
let chartResizeObserver = null;
let currentSymbol = null;

export async function renderChart(container, params = {}) {
  const symbol = params.symbol || currentSymbol || "";

  container.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <h2 style="margin:0">圖表</h2>
      <div style="display:flex;gap:8px">
        <input id="chart-symbol-input" placeholder="輸入代碼" value="${symbol}"
          style="width:120px;padding:8px 10px;font-size:13px" autocapitalize="characters"/>
        <button class="btn primary" id="chart-load-btn" style="padding:8px 14px">查詢</button>
      </div>
    </div>

    <div id="chart-signal-banner" style="margin-bottom:10px"></div>

    <div id="chart-container" style="height:320px;border-radius:10px;overflow:hidden;background:#1a1a1a"></div>

    <div id="chart-actions" style="display:none;margin-top:10px">
      <div class="row">
        <button class="btn secondary" id="chart-add-trade-btn" style="flex:1">＋ 記錄交易</button>
        <button class="btn secondary" id="chart-add-reminder-btn" style="flex:1">🔔 設定提醒</button>
      </div>
    </div>

    <div id="chart-loading" style="display:none">
      <div class="empty"><div class="spinner"></div></div>
    </div>
    <div id="chart-error" style="display:none"></div>
  `;

  const input = document.getElementById("chart-symbol-input");
  document.getElementById("chart-load-btn").addEventListener("click", () => loadChart(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadChart(input.value);
  });

  if (symbol) await loadChart(symbol);
}

async function loadChart(rawSymbol) {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!symbol) { showToast("請輸入代碼"); return; }

  currentSymbol = symbol;

  const loadingEl = document.getElementById("chart-loading");
  const errorEl   = document.getElementById("chart-error");
  const actionsEl = document.getElementById("chart-actions");
  const bannerEl  = document.getElementById("chart-signal-banner");
  const chartEl   = document.getElementById("chart-container");

  loadingEl.style.display = "block";
  errorEl.style.display   = "none";
  actionsEl.style.display = "none";
  bannerEl.innerHTML      = "";
  chartEl.innerHTML       = "";

  // Destroy previous chart instance and observer to avoid memory leaks
  if (chartResizeObserver) {
    chartResizeObserver.disconnect();
    chartResizeObserver = null;
  }
  if (chartInstance) {
    try { chartInstance.remove(); } catch (_) {}
    chartInstance = null;
  }

  try {
    const data = await api.get(`/api/chart/${symbol}?days=90`);
    loadingEl.style.display = "none";

    // Normalize backend response into the shape our renderer expects
    const signalObj = {
      type:       data.signal ?? "none",
      confidence: data.confidence ?? "medium",
      barsAgo:    data.signal_date ? daysSince(data.signal_date) : null,
    };
    renderSignalBanner(bannerEl, signalObj);
    buildChart(chartEl, data);
    actionsEl.style.display = "block";

    document.getElementById("chart-add-trade-btn").onclick = () => openAddTradeSheet(symbol, data);
    document.getElementById("chart-add-reminder-btn").onclick = () => openAddReminderSheet(symbol);
  } catch (err) {
    loadingEl.style.display = "none";
    const msg = err instanceof ApiError && err.status === 404
      ? `找不到「${symbol}」，請確認代碼`
      : "資料載入失敗，請稍後再試";
    errorEl.innerHTML = `<div class="empty">${msg}</div>`;
    errorEl.style.display = "block";
  }
}

function daysSince(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function renderSignalBanner(el, signal) {
  if (!signal || signal.type === "none") {
    el.innerHTML = `<div class="card" style="padding:10px 14px"><span class="text-muted text-sm">近期無明顯交叉訊號</span></div>`;
    return;
  }
  const isGolden = signal.type === "golden_cross";
  const color = isGolden ? "green" : "red";
  const label = isGolden ? "▲ 黃金交叉" : "▼ 死亡交叉";
  const confLabel = signal.confidence === "high" ? "高信心度" : "普通信心度";
  const daysAgo = signal.barsAgo != null ? `${signal.barsAgo} 天前` : "";

  el.innerHTML = `
    <div class="card" style="padding:10px 14px">
      <div class="row">
        <div>
          <span class="badge ${color}">${label}</span>
          <span class="text-sm text-muted" style="margin-left:6px">${daysAgo}</span>
        </div>
        <span class="badge muted">${confLabel}</span>
      </div>
    </div>
  `;
}

function buildChart(el, data) {
  const LC = window.LightweightCharts;
  if (!LC) {
    el.innerHTML = `<div class="empty">圖表庫載入失敗</div>`;
    return;
  }

  const chart = LC.createChart(el, {
    layout: { background: { color: "#1a1a1a" }, textColor: "#888" },
    grid: { vertLines: { color: "#2a2a2a" }, horzLines: { color: "#2a2a2a" } },
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#2a2a2a" },
    timeScale: { borderColor: "#2a2a2a", timeVisible: true },
    width: el.offsetWidth,
    height: el.offsetHeight || 320,
  });
  chartInstance = chart;

  // Candlestick series — backend uses .date (YYYY-MM-DD), LC expects .time
  const candles = chart.addCandlestickSeries({
    upColor: "#00c853", downColor: "#ff1744",
    borderUpColor: "#00c853", borderDownColor: "#ff1744",
    wickUpColor: "#00c853", wickDownColor: "#ff1744",
  });

  const ohlcv = data.ohlcv.map((b) => ({
    time: b.date,
    open: b.open, high: b.high, low: b.low, close: b.close,
  }));
  candles.setData(ohlcv);

  // MA25 line — parallel array, zip with dates
  if (data.ma25?.length) {
    const ma25Series = chart.addLineSeries({ color: "#2979ff", lineWidth: 1, title: "MA25" });
    const ma25Data = data.ohlcv
      .map((b, i) => ({ time: b.date, value: data.ma25[i] }))
      .filter((p) => p.value != null);
    ma25Series.setData(ma25Data);
  }

  // MA60 line
  if (data.ma60?.length) {
    const ma60Series = chart.addLineSeries({ color: "#ffd600", lineWidth: 1, title: "MA60" });
    const ma60Data = data.ohlcv
      .map((b, i) => ({ time: b.date, value: data.ma60[i] }))
      .filter((p) => p.value != null);
    ma60Series.setData(ma60Data);
  }

  // Support lines (green dashed)
  if (data.support?.length) {
    for (const level of data.support) {
      candles.createPriceLine({
        price: level,
        color: "rgba(0,200,83,0.6)",
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: "S",
      })
    }
  }

  // Resistance lines (red dashed)
  if (data.resistance?.length) {
    for (const level of data.resistance) {
      candles.createPriceLine({
        price: level,
        color: "rgba(255,23,68,0.6)",
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: "R",
      })
    }
  }

  chart.timeScale().fitContent();

  // Resize observer for responsive width — tracked so caller can disconnect it
  chartResizeObserver = new ResizeObserver(() => {
    chart.applyOptions({ width: el.offsetWidth });
  });
  chartResizeObserver.observe(el);
}

function openAddTradeSheet(symbol, data) {
  const latestClose = data.ohlcv?.at(-1)?.close ?? "";
  const today = new Date().toISOString().slice(0, 10);

  openSheet(`
    <h3>記錄交易 — ${symbol}</h3>
    <div class="field">
      <label>方向</label>
      <select id="trade-direction">
        <option value="long">做多（買入）</option>
        <option value="short">做空（賣出）</option>
      </select>
    </div>
    <div class="field">
      <label>進場日期</label>
      <input type="date" id="trade-entry-date" value="${today}" />
    </div>
    <div class="field">
      <label>進場價格</label>
      <input type="number" id="trade-entry-price" placeholder="進場價" value="${latestClose}" step="any" />
    </div>
    <div class="field">
      <label>數量（股數 / 顆）</label>
      <input type="number" id="trade-quantity" placeholder="選填" step="any" />
    </div>
    <div class="field">
      <label>備註</label>
      <textarea id="trade-notes" rows="2" placeholder="訊號觸發原因、筆記…"></textarea>
    </div>
    <button class="btn primary full" id="trade-confirm-btn">確認記錄</button>
  `);

  document.getElementById("trade-confirm-btn").addEventListener("click", async () => {
    const direction  = document.getElementById("trade-direction").value;
    const entryDate  = document.getElementById("trade-entry-date").value;
    const entryPrice = parseFloat(document.getElementById("trade-entry-price").value);
    const qty        = document.getElementById("trade-quantity").value;
    const notes      = document.getElementById("trade-notes").value.trim();

    if (!entryDate || isNaN(entryPrice)) {
      showToast("請填入日期與價格");
      return;
    }

    try {
      await api.post("/api/trades", {
        symbol,
        direction,
        entry_date: entryDate,
        entry_price: entryPrice,
        quantity: qty ? parseFloat(qty) : undefined,
        notes: notes || undefined,
      });
      closeSheet();
      showToast("已記錄交易");
    } catch {
      showToast("記錄失敗，請稍後再試");
    }
  });
}

function openAddReminderSheet(symbol) {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  openSheet(`
    <h3>設定提醒 — ${symbol}</h3>
    <div class="field">
      <label>提醒日期</label>
      <input type="date" id="remind-date" value="${tomorrow}" />
    </div>
    <div class="field">
      <label>提醒內容</label>
      <textarea id="remind-note" rows="3" placeholder="例：確認是否突破壓力區、檢查MA趨勢…"></textarea>
    </div>
    <button class="btn primary full" id="remind-confirm-btn">確認設定</button>
  `);

  document.getElementById("remind-confirm-btn").addEventListener("click", async () => {
    const date = document.getElementById("remind-date").value;
    const note = document.getElementById("remind-note").value.trim();

    if (!date) { showToast("請選擇日期"); return; }

    try {
      await api.post("/api/reminders", {
        symbol,
        remind_date: date,
        note: note || undefined,
      });
      closeSheet();
      showToast("提醒已設定");
    } catch {
      showToast("設定失敗，請稍後再試");
    }
  });
}
