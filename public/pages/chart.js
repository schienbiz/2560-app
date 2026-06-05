/**
 * pages/chart.js — Candlestick + RSI + MACD sub-panes, backtest, AI analysis
 *
 * Uses lightweight-charts v4 (window.LightweightCharts).
 * Three synced chart panes: price/MA (240px), RSI-14 (88px), MACD-12/26/9 (88px).
 */

import { api, ApiError } from "../api.js";
import { showToast, openSheet, closeSheet, navigate } from "../app.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ─── Client-side indicator math (mirrors src/engine/indicators.ts) ─────────

function computeEMA(prices, period) {
  const result = new Array(prices.length).fill(null);
  if (prices.length < period) return result;
  const k = 2 / (period + 1);
  result[period - 1] = prices.slice(0, period).reduce((s, p) => s + p, 0) / period;
  for (let i = period; i < prices.length; i++) {
    result[i] = prices[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function computeRSI(prices, period = 14) {
  const result = new Array(prices.length).fill(null);
  if (prices.length < period + 1) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) avgGain += d; else avgLoss += -d;
  }
  avgGain /= period; avgLoss /= period;
  const toRsi = (ag, al) => al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  result[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = toRsi(avgGain, avgLoss);
  }
  return result;
}

function computeMACD(prices, fast = 12, slow = 26, signal = 9) {
  const emaFast = computeEMA(prices, fast);
  const emaSlow = computeEMA(prices, slow);
  const macdLine = prices.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const firstValid = macdLine.findIndex(v => v != null);
  const macdVals = macdLine.filter(v => v != null);
  const sigLine = new Array(prices.length).fill(null);
  if (firstValid >= 0 && macdVals.length >= signal) {
    const sigEMA = computeEMA(macdVals, signal);
    for (let i = 0; i < sigEMA.length; i++) {
      if (sigEMA[i] != null) sigLine[firstValid + i] = sigEMA[i];
    }
  }
  const histogram = prices.map((_, i) =>
    macdLine[i] != null && sigLine[i] != null ? macdLine[i] - sigLine[i] : null
  );
  return { macd: macdLine, signal: sigLine, histogram };
}

// ─── Chart state ────────────────────────────────────────────────────────────

let chartInstances    = [];
let chartResizeObs    = null;
let currentSymbol     = null;

// ─── Page entry point ───────────────────────────────────────────────────────

export async function renderChart(container, params = {}) {
  const symbol = params.symbol || currentSymbol || "";

  container.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <h2 style="margin:0">圖表</h2>
      <div style="display:flex;gap:8px">
        <input id="chart-symbol-input" placeholder="輸入代碼" value="${esc(symbol)}"
          style="width:120px;padding:8px 10px;font-size:13px" autocapitalize="characters"/>
        <button class="btn primary" id="chart-load-btn" style="padding:8px 14px">查詢</button>
      </div>
    </div>

    <div id="chart-signal-banner" style="margin-bottom:10px"></div>

    <div id="chart-container" style="border-radius:10px;overflow:hidden;background:#1a1a1a"></div>

    <div id="chart-analysis" style="display:none"></div>

    <div id="chart-actions" style="display:none;margin-top:10px">
      <div class="row">
        <button class="btn secondary" id="chart-add-trade-btn" style="flex:1">＋ 記錄交易</button>
        <button class="btn secondary" id="chart-add-reminder-btn" style="flex:1">🔔 設定提醒</button>
      </div>
      <div class="row" style="margin-top:8px;gap:8px">
        <button class="btn secondary" id="chart-ai-btn" style="flex:1;color:var(--blue)">✦ AI 分析</button>
        <button class="btn secondary" id="chart-backtest-btn" style="flex:1;color:var(--yellow)">📊 回測</button>
      </div>
      <div style="margin-top:8px">
        <button class="btn secondary" id="chart-swing-toggle-btn" style="display:none;font-size:12px;padding:10px 12px">擺動結構 ON</button>
      </div>
    </div>

    <div id="chart-ai" style="display:none;margin-top:10px"></div>
    <div id="chart-backtest" style="display:none;margin-top:10px"></div>

    <div id="chart-loading" style="display:none">
      <div class="empty"><div class="spinner"></div></div>
    </div>
    <div id="chart-error" style="display:none"></div>
  `;

  const input = document.getElementById("chart-symbol-input");
  document.getElementById("chart-load-btn").addEventListener("click", () => loadChart(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") loadChart(input.value); });

  if (symbol) await loadChart(symbol);
}

// ─── Main loader ─────────────────────────────────────────────────────────────

async function loadChart(rawSymbol) {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!symbol) { showToast("請輸入代碼"); return; }

  currentSymbol = symbol;

  const loadingEl   = document.getElementById("chart-loading");
  const errorEl     = document.getElementById("chart-error");
  const actionsEl   = document.getElementById("chart-actions");
  const bannerEl    = document.getElementById("chart-signal-banner");
  const chartEl     = document.getElementById("chart-container");
  const analysisEl  = document.getElementById("chart-analysis");
  const aiEl        = document.getElementById("chart-ai");
  const backtestEl  = document.getElementById("chart-backtest");

  loadingEl.style.display   = "block";
  errorEl.style.display     = "none";
  actionsEl.style.display   = "none";
  analysisEl.style.display  = "none";
  aiEl.style.display        = "none";
  aiEl.innerHTML            = "";
  backtestEl.style.display  = "none";
  backtestEl.innerHTML      = "";
  bannerEl.innerHTML        = "";
  chartEl.innerHTML         = "";

  destroyCharts();

  try {
    const data = await api.get(`/api/chart/${symbol}?days=120`);
    loadingEl.style.display = "none";

    const signalObj = {
      type:       data.signal ?? "none",
      confidence: data.confidence ?? "medium",
      barsAgo:    data.signal_date ? daysSince(data.signal_date) : null,
      rsi:        data.rsi ?? null,
      macdHist:   data.macdHist ?? null,
    };
    renderSignalBanner(bannerEl, signalObj);
    buildChart(chartEl, data);
    renderAnalysisCard(analysisEl, data, signalObj.barsAgo);
    analysisEl.style.display = "block";
    actionsEl.style.display  = "block";

    const swingToggleBtn = document.getElementById("chart-swing-toggle-btn");
    if (data.swings?.length && swingToggleBtn) {
      const isOn = localStorage.getItem("showSwings") !== "false";
      swingToggleBtn.textContent = isOn ? "擺動結構 ON" : "擺動結構 OFF";
      swingToggleBtn.style.color = isOn ? "var(--blue)" : "var(--muted)";
      swingToggleBtn.style.display = "inline-flex";
      swingToggleBtn.onclick = () => {
        const nowOn = localStorage.getItem("showSwings") !== "false";
        localStorage.setItem("showSwings", nowOn ? "false" : "true");
        destroyCharts();
        buildChart(chartEl, data);
        const next = !nowOn;
        swingToggleBtn.textContent = next ? "擺動結構 ON" : "擺動結構 OFF";
        swingToggleBtn.style.color = next ? "var(--blue)" : "var(--muted)";
      };
    }

    document.getElementById("chart-add-trade-btn").onclick = () => openAddTradeSheet(symbol, data);
    document.getElementById("chart-add-reminder-btn").onclick = () => openAddReminderSheet(symbol);
    document.getElementById("chart-ai-btn").onclick = () => runAiAnalysis(symbol, aiEl);
    document.getElementById("chart-backtest-btn").onclick = () => runBacktest(symbol, backtestEl);
  } catch (err) {
    loadingEl.style.display = "none";
    const msg = err instanceof ApiError && err.status === 404
      ? `找不到「${esc(symbol)}」，請確認代碼`
      : "資料載入失敗，請稍後再試";
    errorEl.innerHTML = `<div class="empty">${msg}</div>`;
    errorEl.style.display = "block";
  }
}

function destroyCharts() {
  if (chartResizeObs) { chartResizeObs.disconnect(); chartResizeObs = null; }
  chartInstances.forEach(c => { try { c.remove(); } catch (_) {} });
  chartInstances = [];
}

function daysSince(dateStr) {
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000));
}

// ─── Signal banner ────────────────────────────────────────────────────────────

function renderSignalBanner(el, signal) {
  const rsiVal   = signal.rsi != null ? signal.rsi.toFixed(1) : null;
  const rsiColor = signal.rsi != null
    ? (signal.rsi >= 70 ? "var(--red)" : signal.rsi <= 30 ? "var(--green)" : "var(--muted)")
    : "var(--muted)";
  const rsiPill = rsiVal
    ? `<span style="margin-left:6px;font-size:11px;font-weight:600;color:${rsiColor}">RSI ${rsiVal}</span>`
    : "";
  const macdPill = signal.macdHist != null
    ? `<span style="margin-left:4px;font-size:11px;color:${signal.macdHist >= 0 ? "var(--green)" : "var(--red)"}">MACD ${signal.macdHist >= 0 ? "▲" : "▼"}</span>`
    : "";

  if (!signal || signal.type === "none") {
    el.innerHTML = `
      <div class="card" style="padding:10px 14px">
        <div class="row">
          <span class="text-muted text-sm">近期無明顯交叉訊號</span>
          <span>${rsiPill}${macdPill}</span>
        </div>
      </div>`;
    return;
  }

  const isGolden  = signal.type === "golden_cross";
  const color     = isGolden ? "green" : "red";
  const label     = isGolden ? "▲ 黃金交叉" : "▼ 死亡交叉";
  const confLabel = signal.confidence === "high" ? "高信心度" : "普通信心度";
  const daysAgo   = signal.barsAgo != null ? `${signal.barsAgo} 天前` : "";

  el.innerHTML = `
    <div class="card" style="padding:10px 14px">
      <div class="row">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">
          <span class="badge ${color}">${label}</span>
          <span class="text-sm text-muted">${daysAgo}</span>
          ${rsiPill}${macdPill}
        </div>
        <span class="badge muted">${confLabel}</span>
      </div>
    </div>`;
}

// ─── Analysis card ────────────────────────────────────────────────────────────

function renderAnalysisCard(el, data, barsAgo) {
  const lastBar = data.ohlcv?.at(-1);
  if (!lastBar) return;

  const close = lastBar.close;
  const ma25  = [...(data.ma25 ?? [])].reverse().find(v => v != null);
  const ma60  = [...(data.ma60 ?? [])].reverse().find(v => v != null);
  if (ma25 == null || ma60 == null) return;

  const maGapPct       = (ma25 - ma60) / ma60 * 100;
  const priceAboveMA25 = (close - ma25) / ma25 * 100;
  const distToStopPct  = (close - ma60) / ma60 * 100;
  const isBullish      = ma25 > ma60;
  const signal         = data.signal ?? "none";

  let entryLabel, entryColor, entryDesc;
  if (signal === "golden_cross") {
    if (barsAgo != null && barsAgo <= 5 && priceAboveMA25 < 5) {
      entryLabel = "適合進場"; entryColor = "var(--green)";
      entryDesc  = `訊號 ${barsAgo} 天前觸發，價格貼近 MA25`;
    } else if (priceAboveMA25 > 8) {
      entryLabel = "追高風險"; entryColor = "var(--yellow)";
      entryDesc  = `距 MA25 偏高 ${priceAboveMA25.toFixed(1)}%，建議等回測`;
    } else {
      entryLabel = "可考慮進場"; entryColor = "var(--blue)";
      entryDesc  = "黃金交叉成立，可分批建倉";
    }
  } else if (signal === "death_cross") {
    entryLabel = "避免做多"; entryColor = "var(--red)";
    entryDesc  = "死亡交叉，多方趨勢轉弱";
  } else {
    if (isBullish) {
      entryLabel = "多頭格局"; entryColor = "var(--blue)";
      entryDesc  = "MA25 高於 MA60，等待黃金交叉確認";
    } else {
      entryLabel = "空頭格局"; entryColor = "var(--muted)";
      entryDesc  = "MA25 低於 MA60，暫不進場";
    }
  }

  const fmt        = n => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const stopWarn   = isBullish && distToStopPct < 3;
  const entryLow   = fmt(ma25 * 0.99);
  const entryHigh  = fmt(ma25 * 1.01);

  // RSI / MACD display values
  const rsiVal   = data.rsi  != null ? data.rsi.toFixed(1) : "N/A";
  const macdVal  = data.macdHist != null ? (data.macdHist >= 0 ? "+" : "") + data.macdHist.toFixed(4) : "N/A";
  const rsiColor = data.rsi != null
    ? (data.rsi >= 70 ? "var(--red)" : data.rsi <= 30 ? "var(--green)" : data.rsi > 50 ? "var(--green)" : "var(--red)")
    : "var(--muted)";
  const macdColor = data.macdHist != null
    ? (data.macdHist > 0 ? "var(--green)" : "var(--red)") : "var(--muted)";
  const rsiLabel = data.rsi != null
    ? (data.rsi >= 70 ? "超買區域" : data.rsi <= 30 ? "超賣區域" : data.rsi > 50 ? "偏多動能" : "偏空動能")
    : "—";
  const macdLabel = data.macdHist != null
    ? (data.macdHist > 0 ? "多頭動能" : "空頭動能") : "—";

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

      <div style="display:flex;gap:8px;margin-bottom:8px">
        <div style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="text-sm text-muted">RSI(14)</div>
          <div style="font-weight:700;color:${rsiColor};margin-top:2px">${rsiVal}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px">${rsiLabel}</div>
        </div>
        <div style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="text-sm text-muted">MACD 柱狀</div>
          <div style="font-weight:700;color:${macdColor};margin-top:2px">${macdVal}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:3px">${macdLabel}</div>
        </div>
      </div>

      <div style="display:flex;gap:8px">
        <div style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px">
          <div class="text-sm text-muted">理想進場區 <span style="font-size:10px">(MA25 附近)</span></div>
          <div style="font-weight:600;font-size:13px;margin-top:4px">${entryLow} – ${entryHigh}</div>
        </div>
        <div style="flex:1;background:var(--bg);border:1px solid ${stopWarn ? "var(--red)" : "var(--border)"};border-radius:8px;padding:10px">
          <div class="text-sm" style="color:${stopWarn ? "var(--red)" : "var(--muted)"};font-weight:${stopWarn ? 600 : 400}">
            策略停損 <span style="font-size:10px">(MA60)</span>
          </div>
          <div style="font-weight:600;font-size:13px;margin-top:4px;color:${stopWarn ? "var(--red)" : "var(--text)"}">
            ${fmt(ma60)}${stopWarn ? " ⚠" : ""}
          </div>
          ${stopWarn ? `<div style="font-size:11px;color:var(--red);margin-top:2px">距停損線 ${distToStopPct.toFixed(1)}%，注意</div>` : ""}
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
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">
            <span style="color:var(--text)">RSI(14)</span>　&gt;70 超買 / &lt;30 超賣 / 50 以上偏多 / 50 以下偏空<br>
            <span style="color:var(--text)">MACD 柱狀</span>　正值（多頭動能）/ 負值（空頭動能）<br>
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

// ─── Chart builder — 3 synced panes ──────────────────────────────────────────

function buildChart(el, data) {
  const LC = window.LightweightCharts;
  if (!LC) { el.innerHTML = `<div class="empty">圖表庫載入失敗</div>`; return; }

  el.innerHTML = `
    <div id="chart-main"  style="height:240px"></div>
    <div id="chart-rsi"   style="height:88px;border-top:1px solid #2a2a2a;position:relative">
      <span style="position:absolute;top:4px;left:8px;font-size:10px;color:#555;z-index:1;pointer-events:none">RSI(14)</span>
    </div>
    <div id="chart-macd"  style="height:88px;border-top:1px solid #2a2a2a;position:relative">
      <span style="position:absolute;top:4px;left:8px;font-size:10px;color:#555;z-index:1;pointer-events:none">MACD(12/26/9)</span>
    </div>
  `;

  const mainEl = el.querySelector("#chart-main");
  const rsiEl  = el.querySelector("#chart-rsi");
  const macdEl = el.querySelector("#chart-macd");
  const w      = el.offsetWidth || 360;

  const base = {
    layout:    { background: { color: "#1a1a1a" }, textColor: "#666" },
    grid:      { vertLines: { color: "#1e1e1e" }, horzLines: { color: "#1e1e1e" } },
    crosshair: { mode: LC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#2a2a2a", minimumWidth: 60 },
    handleScroll: true,
    handleScale:  true,
  };

  const mainChart = LC.createChart(mainEl, { ...base, width: w, height: 240,
    timeScale: { borderColor: "#2a2a2a", timeVisible: true, visible: false },
  });
  const rsiChart  = LC.createChart(rsiEl,  { ...base, width: w, height: 88,
    timeScale: { borderColor: "#2a2a2a", visible: false },
  });
  const macdChart = LC.createChart(macdEl, { ...base, width: w, height: 88,
    timeScale: { borderColor: "#2a2a2a", timeVisible: true, visible: true },
  });

  chartInstances = [mainChart, rsiChart, macdChart];
  syncTimeScales(mainChart, rsiChart, macdChart);

  // ── Main: candlesticks ───────────────────────────────────────────────────
  const candles = mainChart.addCandlestickSeries({
    upColor: "#00c853", downColor: "#ff1744",
    borderUpColor: "#00c853", borderDownColor: "#ff1744",
    wickUpColor:   "#00c853", wickDownColor:   "#ff1744",
  });
  candles.setData(data.ohlcv.map(b => ({ time: b.date, open: b.open, high: b.high, low: b.low, close: b.close })));

  // Swing markers
  if (data.swings?.length && localStorage.getItem("showSwings") !== "false") {
    const STYLE = {
      HH: { position: "aboveBar", color: "#00c853", shape: "arrowUp",   text: "HH" },
      HL: { position: "belowBar", color: "#69f0ae", shape: "arrowDown",  text: "HL" },
      LH: { position: "aboveBar", color: "#ff5252", shape: "arrowUp",   text: "LH" },
      LL: { position: "belowBar", color: "#ff1744", shape: "arrowDown",  text: "LL" },
    };
    const markers = data.swings.slice(-4).map(s => ({ time: s.date, ...STYLE[s.label], size: 1 }))
      .sort((a, b) => a.time < b.time ? -1 : 1);
    candles.setMarkers(markers);
  }

  // MA25 + MA60
  if (data.ma25?.length) {
    const s = mainChart.addLineSeries({ color: "#2979ff", lineWidth: 1, title: "MA25", lastValueVisible: true, priceLineVisible: false });
    s.setData(data.ohlcv.map((b, i) => ({ time: b.date, value: data.ma25[i] })).filter(p => p.value != null));
  }
  if (data.ma60?.length) {
    const s = mainChart.addLineSeries({ color: "#ffd600", lineWidth: 1, title: "MA60", lastValueVisible: true, priceLineVisible: false });
    s.setData(data.ohlcv.map((b, i) => ({ time: b.date, value: data.ma60[i] })).filter(p => p.value != null));
  }

  // Support / Resistance
  if (data.support?.length) {
    for (const lvl of data.support) {
      candles.createPriceLine({ price: lvl, color: "rgba(0,200,83,.5)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "S" });
    }
  }
  if (data.resistance?.length) {
    for (const lvl of data.resistance) {
      candles.createPriceLine({ price: lvl, color: "rgba(255,23,68,.5)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "R" });
    }
  }

  mainChart.timeScale().fitContent();

  // ── RSI sub-pane ──────────────────────────────────────────────────────────
  const closes    = data.ohlcv.map(b => b.close);
  const rsiValues = computeRSI(closes);

  const rsiLine = rsiChart.addLineSeries({
    color: "#bb86fc", lineWidth: 1,
    lastValueVisible: true, priceLineVisible: false,
    priceFormat: { type: "price", minMove: 0.1 },
  });
  rsiLine.setData(
    data.ohlcv.map((b, i) => rsiValues[i] != null ? { time: b.date, value: rsiValues[i] } : null).filter(Boolean)
  );
  rsiLine.createPriceLine({ price: 70, color: "rgba(255,100,100,0.4)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "OB" });
  rsiLine.createPriceLine({ price: 30, color: "rgba(100,200,100,0.4)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "OS" });
  rsiLine.createPriceLine({ price: 50, color: "rgba(150,150,150,0.25)", lineStyle: 2, lineWidth: 1, axisLabelVisible: false });

  // ── MACD sub-pane ─────────────────────────────────────────────────────────
  const macdData = computeMACD(closes);

  const histSeries = macdChart.addHistogramSeries({
    priceFormat: { type: "price", minMove: 0.00001 },
    lastValueVisible: false, priceLineVisible: false,
  });
  histSeries.setData(
    data.ohlcv
      .map((b, i) => macdData.histogram[i] != null ? {
        time:  b.date,
        value: macdData.histogram[i],
        color: macdData.histogram[i] >= 0 ? "rgba(0,200,83,0.7)" : "rgba(255,23,68,0.7)",
      } : null)
      .filter(Boolean)
  );

  const macdLineSeries = macdChart.addLineSeries({ color: "#2979ff", lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
  macdLineSeries.setData(
    data.ohlcv.map((b, i) => macdData.macd[i] != null ? { time: b.date, value: macdData.macd[i] } : null).filter(Boolean)
  );

  const sigLineSeries = macdChart.addLineSeries({ color: "#ff9800", lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
  sigLineSeries.setData(
    data.ohlcv.map((b, i) => macdData.signal[i] != null ? { time: b.date, value: macdData.signal[i] } : null).filter(Boolean)
  );

  // ── Responsive resize ─────────────────────────────────────────────────────
  chartResizeObs = new ResizeObserver(() => {
    const nw = el.offsetWidth;
    chartInstances.forEach(c => c.applyOptions({ width: nw }));
  });
  chartResizeObs.observe(el);
}

// Time scale sync — mutual, loop-safe
function syncTimeScales(...charts) {
  let syncing = false;
  charts.forEach(src => {
    src.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncing || !range) return;
      syncing = true;
      charts.filter(c => c !== src).forEach(t => t.timeScale().setVisibleLogicalRange(range));
      syncing = false;
    });
  });
}

// ─── AI Analysis ──────────────────────────────────────────────────────────────

async function runAiAnalysis(symbol, el) {
  const btn = document.getElementById("chart-ai-btn");
  if (el.style.display === "block") {
    el.style.display = "none"; el.innerHTML = ""; btn.textContent = "✦ AI 分析"; return;
  }
  btn.disabled = true; btn.textContent = "分析中…";
  try {
    const { analysis } = await api.post(`/api/ai/analyze/${symbol}`, {});
    el.innerHTML = `
      <div class="card" style="margin-top:10px;border-top:2px solid var(--blue)">
        <div style="font-size:11px;color:var(--blue);font-weight:600;margin-bottom:8px;letter-spacing:.04em">✦ AI 分析</div>
        <div style="font-size:13px;line-height:1.7;white-space:pre-wrap">${escapeHtml(analysis)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:8px">由 AI 生成，僅供參考，不構成投資建議。</div>
      </div>`;
    el.style.display = "block"; btn.textContent = "✦ 收起分析";
  } catch {
    showToast("AI 分析失敗，請稍後再試"); btn.textContent = "✦ AI 分析";
  } finally { btn.disabled = false; }
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

let _backtestDays = 365;  // persists across open/close toggles

async function runBacktest(symbol, el, days) {
  const btn = document.getElementById("chart-backtest-btn");
  days = days ?? _backtestDays;

  // Toggle off if same period already showing
  if (el.style.display === "block" && days === _backtestDays) {
    el.style.display = "none"; el.innerHTML = ""; btn.textContent = "📊 回測"; return;
  }
  _backtestDays = days;
  btn.disabled = true; btn.textContent = "回測中…";
  el.style.display = "none";

  try {
    const r = await api.get(`/api/backtest/${symbol}?days=${days}`);

    const fmt       = v => v != null ? (v >= 0 ? "+" : "") + v.toFixed(1) + "%" : "—";
    const fmtP      = n => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const fmtF      = v => v != null ? v.toFixed(2) : "—";
    const col       = v => v != null && v >= 0 ? "var(--green)" : "var(--red)";
    const colRate   = v => v != null ? (v >= 0.5 ? "var(--green)" : "var(--red)") : "var(--muted)";
    const confColor = c => c === "high" ? "var(--green)" : c === "medium" ? "var(--yellow)" : "var(--muted)";
    const confLabel = c => c === "high" ? "高" : c === "medium" ? "中" : "低";

    // ── Equity curve SVG ──────────────────────────────────────────────────────
    function equitySVG(cumulative) {
      if (!cumulative || cumulative.length < 2) return "";
      const W = 300, H = 52, pad = 4;
      const min = Math.min(1, ...cumulative), max = Math.max(1, ...cumulative);
      const range = max - min || 0.01;
      const x = i => pad + (i / (cumulative.length - 1)) * (W - 2 * pad);
      const y = v => H - pad - ((v - min) / range) * (H - 2 * pad);
      const pts = cumulative.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
      const baselineY = y(1).toFixed(1);
      const endX = x(cumulative.length - 1).toFixed(1);
      const endVal = cumulative[cumulative.length - 1];
      const lineColor = endVal >= 1 ? "#22c55e" : "#ef4444";
      return `
        <svg width="${W}" height="${H}" style="display:block;margin:0 auto 6px">
          <line x1="${pad}" y1="${baselineY}" x2="${W-pad}" y2="${baselineY}"
                stroke="#333" stroke-width="0.5" stroke-dasharray="3,3"/>
          <polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="1.5" stroke-linejoin="round"/>
          <circle cx="${endX}" cy="${y(endVal).toFixed(1)}" r="2.5" fill="${lineColor}"/>
        </svg>`;
    }

    // ── Confidence breakdown table ────────────────────────────────────────────
    function confTable(byConf) {
      const row = (label, color, g) => {
        if (!g || g.count === 0) return `<tr><td style="color:${color}">${label}</td><td colspan="3" style="color:var(--muted);font-size:11px">無訊號</td></tr>`;
        return `<tr>
          <td style="color:${color}">${label}</td>
          <td>${g.count}</td>
          <td style="color:${colRate(g.win_rate)}">${g.win_rate != null ? (g.win_rate*100).toFixed(0)+"%" : "—"}</td>
          <td style="color:${col(g.avg_return)}">${fmt(g.avg_return)}</td>
        </tr>`;
      };
      return `
        <table style="width:100%;font-size:11px;border-collapse:collapse;margin-top:6px">
          <thead><tr style="color:var(--muted)">
            <th style="text-align:left;padding:2px 0;font-weight:500">信心</th>
            <th style="text-align:right;padding:2px 0;font-weight:500">次數</th>
            <th style="text-align:right;padding:2px 0;font-weight:500">勝率</th>
            <th style="text-align:right;padding:2px 0;font-weight:500">均報酬</th>
          </tr></thead>
          <tbody style="line-height:1.8">
            ${row("高", "var(--green)", byConf.high)}
            ${row("中", "var(--yellow)", byConf.medium)}
            ${row("低", "var(--muted)", byConf.low)}
          </tbody>
        </table>`;
    }

    // ── Trade rows ────────────────────────────────────────────────────────────
    const allTrades = [...r.trades].reverse();
    const PREVIEW = 5;
    function tradeRow(t) {
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:11px;color:var(--muted)">${t.entry_date} → ${t.exit_date} (${t.holding_days}天)</div>
            <div style="font-size:10px;margin-top:1px">
              <span style="color:var(--muted)">${fmtP(t.entry_price)} → ${fmtP(t.exit_price)}</span>
              <span style="margin-left:4px;color:${confColor(t.confidence)}">信心${confLabel(t.confidence)} ${t.factors_passed}/4</span>
            </div>
          </div>
          <span style="font-weight:700;color:${col(t.return_pct)};min-width:48px;text-align:right">${fmt(t.return_pct)}</span>
        </div>`;
    }
    const previewRows = allTrades.slice(0, PREVIEW).map(tradeRow).join("");
    const extraRows   = allTrades.slice(PREVIEW).map(tradeRow).join("");
    const showMore    = allTrades.length > PREVIEW;

    const tradeSection = allTrades.length === 0
      ? `<div class="text-muted text-sm" style="margin-top:8px">回測期間無完整交易（未觸發過死亡交叉）</div>`
      : `${previewRows}
         ${showMore ? `<div id="bt-extra" style="display:none">${extraRows}</div>
           <button id="bt-more-btn" onclick="
             var x=document.getElementById('bt-extra');
             var b=document.getElementById('bt-more-btn');
             if(x.style.display==='none'){x.style.display='block';b.textContent='▲ 收合'}
             else{x.style.display='none';b.textContent='▼ 顯示全部 ${allTrades.length} 筆'}"
             style="font-size:11px;color:var(--blue);background:none;border:none;cursor:pointer;padding:6px 0">
             ▼ 顯示全部 ${allTrades.length} 筆
           </button>` : ""}`;

    const openPosHtml = r.open_position ? `
      <div style="background:rgba(41,121,255,0.08);border:1px solid rgba(41,121,255,0.2);border-radius:8px;padding:10px;margin-bottom:10px">
        <div style="font-size:11px;color:var(--blue);font-weight:600">📌 持倉中（黃金交叉尚未出場）</div>
        <div style="font-size:11px;margin-top:4px;color:var(--muted)">
          進場 ${r.open_position.entry_date} @ ${fmtP(r.open_position.entry_price)}
          <span style="font-weight:700;color:${col(r.open_position.unrealized_pct)}"> ${fmt(r.open_position.unrealized_pct)} 浮動</span>
          <span style="margin-left:6px;color:${confColor(r.open_position.confidence)}">信心${confLabel(r.open_position.confidence)}</span>
        </div>
      </div>` : "";

    // ── Period toggle ─────────────────────────────────────────────────────────
    const periodBtns = [365, 730].map(d => `
      <button onclick="runBacktest('${symbol}', document.getElementById('chart-backtest'), ${d})"
        style="padding:3px 10px;border-radius:12px;border:1px solid var(--border);font-size:11px;cursor:pointer;
               background:${d===days?"var(--yellow)":"var(--bg)"};color:${d===days?"#000":"var(--muted)"}">
        ${d===365?"1年":"2年"}
      </button>`).join("");

    el.innerHTML = `
      <div class="card" style="margin-top:10px;border-top:2px solid var(--yellow)">

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div style="font-size:11px;color:var(--yellow);font-weight:600;letter-spacing:.04em">📊 回測 — ${r.from_date} → ${r.to_date}</div>
          <div style="display:flex;gap:6px">${periodBtns}</div>
        </div>

        <!-- 6 metric cards -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px">
            <div style="font-size:10px;color:var(--muted)">勝率</div>
            <div style="font-size:1.25rem;font-weight:700;color:${colRate(r.win_rate)}">
              ${r.win_rate != null ? (r.win_rate*100).toFixed(0)+"%" : "—"}
            </div>
            <div style="font-size:10px;color:var(--muted)">${r.win_count}勝 ${r.loss_count}敗</div>
          </div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px">
            <div style="font-size:10px;color:var(--muted)">均報酬</div>
            <div style="font-size:1.25rem;font-weight:700;color:${col(r.avg_return)}">${fmt(r.avg_return)}</div>
            <div style="font-size:10px;color:var(--muted)">${r.trades.length} 次交易</div>
          </div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px">
            <div style="font-size:10px;color:var(--muted)">獲利因子</div>
            <div style="font-size:1.25rem;font-weight:700;color:${r.profit_factor!=null&&r.profit_factor>=1?"var(--green)":"var(--red)"}">
              ${r.profit_factor != null ? r.profit_factor.toFixed(2) : "—"}
            </div>
            <div style="font-size:10px;color:var(--muted)">總獲利/總虧損</div>
          </div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px">
            <div style="font-size:10px;color:var(--muted)">最大回落</div>
            <div style="font-size:1.25rem;font-weight:700;color:${r.max_drawdown!=null&&r.max_drawdown>15?"var(--red)":"var(--yellow)"}">
              ${r.max_drawdown != null ? "-"+r.max_drawdown.toFixed(1)+"%" : "—"}
            </div>
            <div style="font-size:10px;color:var(--muted)">峰值到谷底</div>
          </div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px">
            <div style="font-size:10px;color:var(--muted)">期望值</div>
            <div style="font-size:1.25rem;font-weight:700;color:${col(r.expectancy)}">${fmt(r.expectancy)}</div>
            <div style="font-size:10px;color:var(--muted)">每次交易均損益</div>
          </div>
          <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px">
            <div style="font-size:10px;color:var(--muted)">最佳/最差</div>
            <div style="font-size:11px;font-weight:700">
              <span style="color:var(--green)">${fmt(r.best_trade)}</span>
              <span style="color:var(--muted)"> / </span>
              <span style="color:var(--red)">${fmt(r.worst_trade)}</span>
            </div>
            <div style="font-size:10px;color:var(--muted)">均勝 ${fmt(r.avg_win)} 均敗 ${fmt(r.avg_loss)}</div>
          </div>
        </div>

        <!-- Equity curve -->
        ${r.cumulative && r.cumulative.length >= 2 ? `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:10px">
          <div style="font-size:10px;color:var(--muted);margin-bottom:4px">累積資金曲線（各交易複利）</div>
          ${equitySVG(r.cumulative)}
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted)">
            <span>起始 1.00</span>
            <span style="color:${col(r.cumulative[r.cumulative.length-1]-1)}">
              終點 ${r.cumulative[r.cumulative.length-1].toFixed(3)}
              (${fmt((r.cumulative[r.cumulative.length-1]-1)*100)})
            </span>
          </div>
        </div>` : ""}

        ${openPosHtml}

        <!-- Confidence breakdown -->
        ${r.by_confidence ? `
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:10px">
          <div style="font-size:10px;color:var(--muted);font-weight:600;margin-bottom:2px">4因子信心分組表現</div>
          ${confTable(r.by_confidence)}
        </div>` : ""}

        <!-- Trades -->
        <div>
          <div style="font-size:11px;color:var(--muted);font-weight:600;margin-bottom:4px">交易記錄</div>
          ${tradeSection}
        </div>

        <div style="font-size:10px;color:var(--muted);margin-top:10px">
          進場=黃金交叉收盤，出場=死亡交叉收盤。不含手續費/滑價。回測為事後統計，不代表未來績效。
        </div>
      </div>`;

    el.style.display = "block";
    btn.textContent = "📊 收起回測";
  } catch (err) {
    const msg = err instanceof ApiError && err.status === 400 ? "資料不足，無法回測" : "回測失敗，請稍後再試";
    showToast(msg); btn.textContent = "📊 回測";
  } finally { btn.disabled = false; }
}

// ─── Trade / Reminder sheets ──────────────────────────────────────────────────

function taipeiToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

function openAddTradeSheet(symbol, data) {
  const latestClose = data.ohlcv?.at(-1)?.close ?? "";
  const today = taipeiToday();

  openSheet(`
    <h3>記錄交易 — ${esc(symbol)}</h3>
    <div class="field"><label>方向</label>
      <select id="trade-direction">
        <option value="long">做多（買入）</option>
        <option value="short">做空（賣出）</option>
      </select>
    </div>
    <div class="field"><label>進場日期</label><input type="date" id="trade-entry-date" value="${today}" /></div>
    <div class="field"><label>進場價格</label><input type="number" id="trade-entry-price" value="${latestClose}" step="any" /></div>
    <div class="field"><label>數量（股數 / 顆）</label><input type="number" id="trade-quantity" placeholder="選填" step="any" /></div>
    <div class="field"><label>備註</label><textarea id="trade-notes" rows="2" placeholder="訊號觸發原因、筆記…"></textarea></div>
    <button class="btn primary full" id="trade-confirm-btn">確認記錄</button>
  `);

  document.getElementById("trade-confirm-btn").addEventListener("click", async () => {
    const direction  = document.getElementById("trade-direction").value;
    const entryDate  = document.getElementById("trade-entry-date").value;
    const entryPrice = parseFloat(document.getElementById("trade-entry-price").value);
    const qty        = document.getElementById("trade-quantity").value;
    const notes      = document.getElementById("trade-notes").value.trim();
    if (!entryDate || isNaN(entryPrice)) { showToast("請填入日期與價格"); return; }
    const btn = document.getElementById("trade-confirm-btn");
    btn.disabled = true; btn.textContent = "記錄中…";
    try {
      await api.post("/api/trades", { symbol, direction, entry_date: entryDate,
        entry_price: entryPrice, quantity: qty ? parseFloat(qty) : undefined, notes: notes || undefined });
      closeSheet(); showToast("已記錄交易");
    } catch {
      showToast("記錄失敗，請稍後再試");
      btn.disabled = false; btn.textContent = "確認記錄";
    }
  });
}

function openAddReminderSheet(symbol) {
  const d = new Date(taipeiToday());
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);

  openSheet(`
    <h3>設定提醒 — ${esc(symbol)}</h3>
    <div class="field"><label>提醒日期</label><input type="date" id="remind-date" value="${tomorrow}" /></div>
    <div class="field"><label>提醒內容</label><textarea id="remind-note" rows="3" placeholder="例：確認是否突破壓力區、檢查MA趨勢…"></textarea></div>
    <button class="btn primary full" id="remind-confirm-btn">確認設定</button>
  `);

  document.getElementById("remind-confirm-btn").addEventListener("click", async () => {
    const date = document.getElementById("remind-date").value;
    const note = document.getElementById("remind-note").value.trim();
    if (!date) { showToast("請選擇日期"); return; }
    const btn = document.getElementById("remind-confirm-btn");
    btn.disabled = true; btn.textContent = "設定中…";
    try {
      await api.post("/api/reminders", { symbol, remind_date: date, note: note || undefined });
      closeSheet(); showToast("提醒已設定");
    } catch {
      showToast("設定失敗，請稍後再試");
      btn.disabled = false; btn.textContent = "確認設定";
    }
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
