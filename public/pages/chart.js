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

    <div id="chart-analysis" style="display:none"></div>

    <div id="chart-ai" style="display:none;margin-top:10px"></div>

    <div id="chart-actions" style="display:none;margin-top:10px">
      <div class="row">
        <button class="btn secondary" id="chart-add-trade-btn" style="flex:1">＋ 記錄交易</button>
        <button class="btn secondary" id="chart-add-reminder-btn" style="flex:1">🔔 設定提醒</button>
      </div>
      <button class="btn secondary" id="chart-ai-btn" style="width:100%;margin-top:8px;color:var(--blue)">✦ AI 分析</button>
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

  const analysisEl = document.getElementById("chart-analysis");
  const aiEl       = document.getElementById("chart-ai");

  loadingEl.style.display   = "block";
  errorEl.style.display     = "none";
  actionsEl.style.display   = "none";
  analysisEl.style.display  = "none";
  aiEl.style.display        = "none";
  aiEl.innerHTML            = "";
  bannerEl.innerHTML        = "";
  chartEl.innerHTML         = "";

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
    const data = await api.get(`/api/chart/${symbol}?days=120`);
    loadingEl.style.display = "none";

    // Normalize backend response into the shape our renderer expects
    const signalObj = {
      type:       data.signal ?? "none",
      confidence: data.confidence ?? "medium",
      barsAgo:    data.signal_date ? daysSince(data.signal_date) : null,
    };
    renderSignalBanner(bannerEl, signalObj);
    buildChart(chartEl, data);
    renderAnalysisCard(analysisEl, data, signalObj.barsAgo);
    analysisEl.style.display = "block";
    actionsEl.style.display  = "block";

    document.getElementById("chart-add-trade-btn").onclick = () => openAddTradeSheet(symbol, data);
    document.getElementById("chart-add-reminder-btn").onclick = () => openAddReminderSheet(symbol);
    document.getElementById("chart-ai-btn").onclick = () => runAiAnalysis(symbol, aiEl);
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

function renderAnalysisCard(el, data, barsAgo) {
  const lastBar = data.ohlcv?.at(-1);
  if (!lastBar) return;

  const close = lastBar.close;
  const ma25  = [...(data.ma25 ?? [])].reverse().find(v => v != null);
  const ma60  = [...(data.ma60 ?? [])].reverse().find(v => v != null);
  if (ma25 == null || ma60 == null) return;

  const maGapPct         = (ma25 - ma60) / ma60 * 100;
  const priceAboveMA25   = (close - ma25) / ma25 * 100;
  const distToStopPct    = (close - ma60) / ma60 * 100;
  const isBullish        = ma25 > ma60;
  const signal           = data.signal ?? "none";

  // ── Entry guidance ──────────────────────────────────────────────────────────
  let entryLabel, entryColor, entryDesc;
  if (signal === "golden_cross") {
    if (barsAgo != null && barsAgo <= 5 && priceAboveMA25 < 5) {
      entryLabel = "適合進場";
      entryColor = "var(--green)";
      entryDesc  = `訊號 ${barsAgo} 天前觸發，價格貼近 MA25`;
    } else if (priceAboveMA25 > 8) {
      entryLabel = "追高風險";
      entryColor = "var(--yellow)";
      entryDesc  = `距 MA25 偏高 ${priceAboveMA25.toFixed(1)}%，建議等回測`;
    } else {
      entryLabel = "可考慮進場";
      entryColor = "var(--blue)";
      entryDesc  = "黃金交叉成立，可分批建倉";
    }
  } else if (signal === "death_cross") {
    entryLabel = "避免做多";
    entryColor = "var(--red)";
    entryDesc  = "死亡交叉，多方趨勢轉弱";
  } else {
    if (isBullish) {
      entryLabel = "多頭格局";
      entryColor = "var(--blue)";
      entryDesc  = "MA25 高於 MA60，等待黃金交叉確認";
    } else {
      entryLabel = "空頭格局";
      entryColor = "var(--muted)";
      entryDesc  = "MA25 低於 MA60，暫不進場";
    }
  }

  // ── Formatting helpers ──────────────────────────────────────────────────────
  const fmt = n => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const stopWarning = isBullish && distToStopPct < 3;

  // Ideal entry zone: MA25 ±1%
  const entryLow  = fmt(ma25 * 0.99);
  const entryHigh = fmt(ma25 * 1.01);

  el.innerHTML = `
    <div class="card" style="margin-top:10px">
      <div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px">進退場分析</div>

      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="text-sm text-muted">進場建議</div>
          <div style="font-weight:700;color:${entryColor};margin-top:2px">${entryLabel}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px;line-height:1.4">${entryDesc}</div>
        </div>
        <div style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="text-sm text-muted">MA 距離</div>
          <div style="font-weight:700;color:${maGapPct >= 0 ? "var(--green)" : "var(--red)"};margin-top:2px">
            ${maGapPct >= 0 ? "+" : ""}${maGapPct.toFixed(1)}%
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px;line-height:1.4">
            ${maGapPct >= 0 ? "MA25 高於 MA60，多頭" : "MA25 低於 MA60，空頭"}
          </div>
        </div>
      </div>

      <div style="display:flex;gap:8px">
        <div style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="text-sm text-muted">理想進場區 <span style="font-size:10px">(MA25 附近)</span></div>
          <div style="font-weight:600;font-size:13px;margin-top:4px">${entryLow} – ${entryHigh}</div>
        </div>
        <div style="flex:1;background:var(--bg);border:1px solid ${stopWarning ? "var(--red)" : "var(--border)"};border-radius:8px;padding:10px">
          <div class="text-sm" style="color:${stopWarning ? "var(--red)" : "var(--muted)"};font-weight:${stopWarning ? 600 : 400}">
            策略停損 <span style="font-size:10px">(MA60)</span>
          </div>
          <div style="font-weight:600;font-size:13px;margin-top:4px;color:${stopWarning ? "var(--red)" : "var(--text)"}">
            ${fmt(ma60)}${stopWarning ? " ⚠" : ""}
          </div>
          ${stopWarning ? `<div style="font-size:11px;color:var(--red);margin-top:2px">距停損線 ${distToStopPct.toFixed(1)}%，注意</div>` : ""}
        </div>
      </div>

      <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
        <button id="analysis-legend-toggle" style="background:none;border:none;color:var(--muted);font-size:12px;cursor:pointer;padding:0;display:flex;align-items:center;gap:4px;-webkit-tap-highlight-color:transparent">
          <span id="analysis-legend-arrow">▶</span> 判斷邏輯說明
        </button>
        <div id="analysis-legend" style="display:none;margin-top:8px;font-size:11px;line-height:1.8;color:var(--muted)">
          <div><span style="color:var(--green);font-weight:600">● 適合進場</span>　黃金交叉 ≤5 天，且價格距 MA25 不超過 5%</div>
          <div><span style="color:var(--blue);font-weight:600">● 可考慮進場</span>　黃金交叉成立，但時間或距離稍長</div>
          <div><span style="color:var(--yellow);font-weight:600">● 追高風險</span>　黃金交叉後，價格已高於 MA25 超過 8%</div>
          <div><span style="color:var(--red);font-weight:600">● 避免做多</span>　死亡交叉（MA25 向下穿越 MA60）</div>
          <div><span style="color:var(--muted);font-weight:600">● 多/空頭格局</span>　無明顯交叉訊號，顯示目前 MA 趨勢方向</div>
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">
            <span style="color:var(--text)">理想進場區</span>　MA25 ±1%，趨勢剛確立時的低風險進場範圍<br>
            <span style="color:var(--text)">策略停損</span>　MA60 數值，2560 戰法以此作為多方格局的支撐下限
          </div>
        </div>
      </div>
    </div>
  `;

  el.querySelector("#analysis-legend-toggle").addEventListener("click", () => {
    const legend = el.querySelector("#analysis-legend");
    const arrow  = el.querySelector("#analysis-legend-arrow");
    const open   = legend.style.display === "none";
    legend.style.display = open ? "block" : "none";
    arrow.textContent    = open ? "▼" : "▶";
  });
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

function taipeiToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

function openAddTradeSheet(symbol, data) {
  const latestClose = data.ohlcv?.at(-1)?.close ?? "";
  const today = taipeiToday();

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

    const btn = document.getElementById("trade-confirm-btn");
    btn.disabled = true;
    btn.textContent = "記錄中…";
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
      btn.disabled = false;
      btn.textContent = "確認記錄";
    }
  });
}

function openAddReminderSheet(symbol) {
  const d = new Date(taipeiToday());
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);

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

    const btn = document.getElementById("remind-confirm-btn");
    btn.disabled = true;
    btn.textContent = "設定中…";
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
      btn.disabled = false;
      btn.textContent = "確認設定";
    }
  });
}

// ─── AI Analysis ──────────────────────────────────────────────────────────────

async function runAiAnalysis(symbol, el) {
  const btn = document.getElementById("chart-ai-btn");

  // If analysis already shown, toggle it off
  if (el.style.display === "block") {
    el.style.display = "none";
    el.innerHTML = "";
    btn.textContent = "✦ AI 分析";
    return;
  }

  btn.disabled = true;
  btn.textContent = "分析中…";

  try {
    const { analysis } = await api.post(`/api/ai/analyze/${symbol}`, {});
    el.innerHTML = `
      <div class="card" style="margin-top:10px;border-top:2px solid var(--blue)">
        <div style="font-size:11px;color:var(--blue);font-weight:600;margin-bottom:8px;letter-spacing:.04em">✦ AI 分析</div>
        <div style="font-size:13px;line-height:1.7;white-space:pre-wrap">${escapeHtml(analysis)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:8px">由 AI 生成，僅供參考，不構成投資建議。</div>
      </div>
    `;
    el.style.display = "block";
    btn.textContent = "✦ 收起分析";
  } catch {
    showToast("AI 分析失敗，請稍後再試");
    btn.textContent = "✦ AI 分析";
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
