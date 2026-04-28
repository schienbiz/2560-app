/**
 * pages/watchlist.js — Watchlist page
 *
 * Shows user's watched symbols with current signal badge.
 * Tap a row → switches to chart tab for that symbol.
 * 立即掃描 button → scans all symbols and shows live signal + SR status.
 * + button → bottom sheet to add a new symbol.
 */

import { api, ApiError } from "../api.js";
import { showToast, openSheet, closeSheet, navigate } from "../app.js";
import { getSession } from "../platform.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Encode symbol to a collision-resistant CSS ID: non-alphanumeric chars become _<charCode>_
// e.g. "BTC/USDT" → "BTC_47_USDT", "2330.TW" → "2330_46_TW"
function safeId(sym) { return String(sym).replace(/[^a-zA-Z0-9]/g, c => `_${c.charCodeAt(0)}_`); }

// ── WebSocket live-price client ───────────────────────────────────────────────

let _ws = null;
let _reconnectTimer = null;

function connectWs() {
  clearTimeout(_reconnectTimer);
  _reconnectTimer = null;
  if (_ws) { _ws.close(); _ws = null; }

  const session = getSession();
  if (!session) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  _ws = ws;

  ws.onopen = () => {
    const token = session.platform === "telegram"
      ? `TG ${session.token}`
      : `Bearer ${session.token}`;
    ws.send(JSON.stringify({ type: "auth", token }));
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === "price") applyPriceUpdate(msg);
  };

  ws.onclose = () => {
    _ws = null;
    // Reconnect only if watchlist tab is still active
    const page = document.getElementById("page-watchlist");
    if (page?.classList.contains("active")) {
      _reconnectTimer = setTimeout(connectWs, 5000);
    }
  };

  ws.onerror = () => ws.close();
}

function applyPriceUpdate(msg) {
  const sym = msg.symbol;
  const sid = safeId(sym);

  const priceEl  = document.getElementById(`wl-price-${sid}`);
  const maEl     = document.getElementById(`wl-ma-${sid}`);
  const signalEl = document.getElementById(`wl-signal-${sid}`);

  if (priceEl && msg.close != null) {
    priceEl.textContent = Number(msg.close).toLocaleString(undefined, { maximumFractionDigits: 4 });
    priceEl.style.color = "var(--text)";
  }

  if (maEl && msg.ma25 != null && msg.ma60 != null) {
    const above = msg.ma25 > msg.ma60;
    maEl.textContent = above ? "MA25>MA60" : "MA25<MA60";
    maEl.style.color = above ? "var(--green)" : "var(--red)";
  }

  if (signalEl) {
    if (msg.signal === "golden_cross") {
      signalEl.innerHTML = `<span class="badge green">▲ 黃金交叉</span>`;
    } else if (msg.signal === "death_cross") {
      signalEl.innerHTML = `<span class="badge red">▼ 死亡交叉</span>`;
    } else if (msg.signal != null) {
      // "none" or any unrecognized value → reset to neutral
      signalEl.innerHTML = BADGE_NONE;
    }
  }
}

function strategyIntroCard() {
  const dismissed = localStorage.getItem("wl-intro-dismissed") === "1";
  if (dismissed) return "";
  return `
    <div id="wl-intro" class="card" style="margin-bottom:16px;border-color:#2979ff44;background:#2979ff0d">
      <div class="row" style="align-items:flex-start">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:700;color:var(--blue);margin-bottom:6px">什麼是 2560 戰法？</div>
          <div style="font-size:12px;color:var(--text);line-height:1.6">
            利用 <strong>25 日均線（MA25）</strong>和 <strong>60 日均線（MA60）</strong>的交叉判斷買賣時機：
          </div>
          <div style="font-size:12px;margin-top:6px;line-height:1.8">
            <div><span class="badge green" style="margin-right:6px">▲ 黃金交叉</span>MA25 由下往上穿越 MA60 → <strong>買入訊號</strong></div>
            <div style="margin-top:4px"><span class="badge red" style="margin-right:6px">▼ 死亡交叉</span>MA25 由上往下穿越 MA60 → <strong>賣出訊號</strong></div>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:8px">均線 = 過去 N 天收盤價的平均值，反映中期趨勢方向。</div>
        </div>
        <button id="wl-intro-close" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:0 0 0 8px;line-height:1">×</button>
      </div>
    </div>
  `;
}

const BADGE_NONE = `<span class="badge muted">無訊號</span>`;

export async function renderWatchlist(container) {
  container.innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <h2 style="margin:0">自選清單</h2>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn secondary" id="wl-scan-btn" style="padding:8px 12px">⚡ 掃描</button>
        <button class="btn secondary" id="wl-add-btn" style="padding:8px 12px">＋ 新增</button>
      </div>
    </div>
    ${strategyIntroCard()}
    <div id="wl-scan-results"></div>
    <div id="wl-list"><div class="empty"><div class="spinner"></div></div></div>
  `;

  const closeBtn = document.getElementById("wl-intro-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      localStorage.setItem("wl-intro-dismissed", "1");
      document.getElementById("wl-intro")?.remove();
    });
  }

  document.getElementById("wl-add-btn").addEventListener("click", openAddSheet);
  document.getElementById("wl-scan-btn").addEventListener("click", () => runScan(container));
  await loadList(container);
  connectWs();
}

async function loadList(container) {
  const listEl = container.querySelector("#wl-list");
  try {
    const items = await api.get("/api/watchlist");
    if (!items.length) {
      listEl.innerHTML = `<div class="empty">尚無自選標的<br>點擊右上角「＋ 新增」開始追蹤</div>`;
      return;
    }
    listEl.innerHTML = items.map(renderRow).join("");

    listEl.querySelectorAll(".wl-row").forEach((el) => {
      el.addEventListener("click", () => {
        navigate("chart", { symbol: el.dataset.symbol });
      });
    });

    listEl.querySelectorAll(".wl-settings").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openSettingsSheet(btn.dataset, container);
      });
    });

    listEl.querySelectorAll(".wl-delete").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          await api.delete(`/api/watchlist/${id}`);
          showToast("已移除");
          await loadList(container);
        } catch {
          showToast("移除失敗");
        }
      });
    });
  } catch {
    listEl.innerHTML = `<div class="empty">載入失敗，請稍後再試</div>`;
  }
}

function renderRow(item) {
  const sig = item.lastSignal;
  let badge = BADGE_NONE;
  if (sig?.signal === "golden_cross") {
    badge = `<span class="badge green">▲ 黃金交叉</span>`;
  } else if (sig?.signal === "death_cross") {
    badge = `<span class="badge red">▼ 死亡交叉</span>`;
  }

  const displayName = esc(item.label || item.symbol);
  const sid = safeId(item.symbol);
  const sigDate = sig?.signal_date
    ? `<div class="text-sm text-muted" style="margin-top:2px">${esc(String(sig.signal_date).slice(0, 10))}</div>`
    : "";

  return `
    <div class="card wl-row" data-symbol="${esc(item.symbol)}" style="cursor:pointer;padding:12px 14px">
      <div class="row" style="align-items:flex-start">
        <div style="flex:1;min-width:0;margin-right:8px">
          <div style="font-weight:700;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${displayName}${item.label ? `<span class="text-sm text-muted" style="font-weight:400;margin-left:6px">${esc(item.symbol)}</span>` : ""}
          </div>
          <div style="display:flex;gap:8px;margin-top:3px;align-items:center">
            <span id="wl-price-${sid}" class="text-sm" style="color:var(--muted)">—</span>
            <span id="wl-ma-${sid}" class="text-sm"></span>
          </div>
          ${sigDate}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
          <span id="wl-signal-${sid}">${badge}</span>
          <div style="display:flex;gap:6px">
            <button class="btn secondary wl-settings" data-id="${item.id}" data-symbol="${esc(item.symbol)}" data-label="${esc(item.label || "")}" data-on-golden="${item.alert?.on_golden ?? true}" data-on-death="${item.alert?.on_death ?? true}" data-active="${item.alert?.active ?? true}" data-proximity-threshold="${item.alert?.proximity_threshold ?? 0.015}" data-ma25="${item.lastSignal?.ma25 ?? ""}" style="padding:5px 9px;font-size:14px;min-height:34px" title="設定">⚙</button>
            <button class="btn danger wl-delete" data-id="${item.id}" style="padding:5px 9px;font-size:12px;min-height:34px">移除</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Live scan ─────────────────────────────────────────────────────────────────

async function runScan(container) {
  const scanBtn   = document.getElementById("wl-scan-btn");
  const resultsEl = document.getElementById("wl-scan-results");

  scanBtn.disabled = true;
  scanBtn.textContent = "掃描中…";
  resultsEl.innerHTML = `<div class="card" style="margin-bottom:10px"><div class="empty" style="padding:16px"><div class="spinner"></div></div></div>`;

  try {
    const results = await api.get("/api/scan");
    if (!results.length) {
      resultsEl.innerHTML = "";
      showToast("自選清單為空");
      return;
    }
    resultsEl.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px">
          即時掃描結果 — ${new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}
        </div>
        ${results.map(renderScanRow).join("")}
      </div>
    `;

    // Tap scan row → go to chart
    resultsEl.querySelectorAll(".scan-row").forEach((el) => {
      el.addEventListener("click", () => navigate("chart", { symbol: el.dataset.symbol }));
    });

    // 高信心 tooltip
    resultsEl.querySelectorAll(".conf-tip").forEach(el => {
      el.addEventListener("click", e => {
        e.stopPropagation();
        showToast("成交量放大（超過10日均量×1.2）且價格貼近 MA60，訊號可信度較高", 4000);
      });
    });
  } catch {
    resultsEl.innerHTML = "";
    showToast("掃描失敗，請稍後再試");
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "⚡ 掃描";
  }
}

function renderScanRow(item) {
  if (item.error) {
    return `
      <div class="row scan-row" data-symbol="${item.symbol}" style="padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">
        <span style="font-weight:600">${item.symbol}</span>
        <span class="text-muted text-sm">載入失敗</span>
      </div>
    `;
  }

  let badge = BADGE_NONE;
  if (item.signal === "golden_cross") badge = `<span class="badge green">▲ 黃金交叉</span>`;
  if (item.signal === "death_cross")  badge = `<span class="badge red">▼ 死亡交叉</span>`;

  const conf = item.confidence === "high"
    ? `<span class="text-sm conf-tip" style="color:var(--yellow);cursor:pointer" title="成交量放大 + 價格貼近 MA60，訊號可信度較高">高信心 ⓘ</span>`
    : "";

  const closePrice = item.close != null
    ? `<span class="text-sm text-muted">${Number(item.close).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>`
    : "";

  const ma25above = item.ma25 != null && item.ma60 != null
    ? item.ma25 > item.ma60
      ? `<span class="text-sm text-green">MA25&gt;MA60</span>`
      : `<span class="text-sm text-red">MA25&lt;MA60</span>`
    : "";

  return `
    <div class="scan-row" data-symbol="${item.symbol}"
      style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);cursor:pointer">
      <div>
        <span style="font-weight:700">${item.symbol}</span>
        <div style="display:flex;gap:6px;margin-top:3px">${closePrice}${ma25above}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        ${badge}
        ${conf}
      </div>
    </div>
  `;
}

// ── Settings sheet ───────────────────────────────────────────────────────────

function openSettingsSheet(dataset, container) {
  const { id, symbol, label, onGolden, onDeath, active, proximityThreshold, ma25 } = dataset;
  const checked = (val) => val === "true" ? "checked" : "";
  const thresholdPct = (parseFloat(proximityThreshold) * 100).toFixed(1);
  const goldenIsOn   = onGolden === "true";

  // Price context: if MA25 is known, show what the % means in absolute terms
  const ma25Val = parseFloat(ma25);
  const priceContextHint = (ma25Val > 0)
    ? `目前等於 MA25 ${ma25Val.toFixed(2)} ± ${(ma25Val * parseFloat(thresholdPct) / 100).toFixed(2)}`
    : "";

  openSheet(`
    <h3>⚙ ${esc(symbol)} 設定</h3>
    <div class="field">
      <label>顯示名稱（選填）</label>
      <input id="settings-label-input" placeholder="${esc(symbol)}" value="${esc(label)}" maxlength="50" />
      <div class="text-sm text-muted" style="margin-top:4px">留空則顯示股票代碼</div>
    </div>
    <div class="field" style="margin-top:16px">
      <label style="margin-bottom:8px;display:block">通知設定</label>
      <label class="toggle-row" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
        <span>▲ 黃金交叉通知</span>
        <input type="checkbox" id="settings-golden" ${checked(onGolden)} />
      </label>
      <label class="toggle-row" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
        <span>▼ 死亡交叉通知</span>
        <input type="checkbox" id="settings-death" ${checked(onDeath)} />
      </label>
      <label class="toggle-row" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0">
        <span>啟用此標的通知</span>
        <input type="checkbox" id="settings-active" ${checked(active)} />
      </label>
    </div>
    <div class="divider"></div>
    <div id="settings-proximity-section" style="opacity:${goldenIsOn ? 1 : 0.4};transition:opacity .2s">
      <label style="margin-bottom:8px;display:block">接近 MA25 警示門檻
        <span class="text-sm text-muted">（黃金交叉通知啟用時有效）</span>
      </label>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <span class="text-sm text-muted">${priceContextHint}</span>
        <span id="settings-threshold-display" style="font-weight:600;color:var(--blue)">${thresholdPct}%</span>
      </div>
      <input type="range" id="settings-threshold" min="0.1" max="5" step="0.1" value="${thresholdPct}"
        style="width:100%" ${goldenIsOn ? "" : "disabled"} />
      <div class="text-sm text-muted" style="margin-top:4px">價格距 MA25 在此範圍內時觸發（預設 1.5%）</div>
    </div>
    <button class="btn primary full" id="settings-save" style="margin-top:16px">儲存</button>
  `);

  document.getElementById("settings-threshold").addEventListener("input", (e) => {
    const pct = parseFloat(e.target.value).toFixed(1);
    document.getElementById("settings-threshold-display").textContent = pct + "%";
    if (priceContextHint && ma25Val > 0) {
      // Update price context hint live as slider moves
      const section = document.getElementById("settings-proximity-section");
      const hint = section?.querySelector(".text-sm.text-muted");
      if (hint) hint.textContent = `目前等於 MA25 ${ma25Val.toFixed(2)} ± ${(ma25Val * parseFloat(pct) / 100).toFixed(2)}`;
    }
  });

  // Golden toggle gates the proximity slider
  document.getElementById("settings-golden").addEventListener("change", (e) => {
    const section = document.getElementById("settings-proximity-section");
    const slider  = document.getElementById("settings-threshold");
    if (section) section.style.opacity = e.target.checked ? "1" : "0.4";
    if (slider)  slider.disabled = !e.target.checked;
  });

  document.getElementById("settings-save").addEventListener("click", async () => {
    const newLabel = document.getElementById("settings-label-input").value.trim();
    const newGolden = document.getElementById("settings-golden").checked;
    const newDeath = document.getElementById("settings-death").checked;
    const newActive = document.getElementById("settings-active").checked;
    const newThreshold = parseFloat(document.getElementById("settings-threshold").value) / 100;

    const btn = document.getElementById("settings-save");
    btn.disabled = true;
    btn.textContent = "儲存中…";

    try {
      await Promise.all([
        api.put(`/api/watchlist/${id}`, { label: newLabel || null }),
        api.put(`/api/watchlist/${id}/alert`, {
          on_golden:           newGolden,
          on_death:            newDeath,
          active:              newActive,
          proximity_threshold: newThreshold,
        }),
      ]);
      closeSheet();
      showToast("已儲存");
      await loadList(container);
    } catch {
      showToast("儲存失敗");
      btn.disabled = false;
      btn.textContent = "儲存";
    }
  });
}

// ── Add symbol sheet ──────────────────────────────────────────────────────────

function openAddSheet() {
  openSheet(`
    <h3>新增自選標的</h3>
    <div class="field">
      <label>股票代碼 / 加密貨幣對</label>
      <input id="add-symbol-input" placeholder="例：2330 / BTCUSDT / AAPL" autocapitalize="characters" />
      <div class="text-sm text-muted" style="margin-top:4px">
        台股輸入數字代碼（如 2330），加密貨幣輸入交易對（如 BTCUSDT）
      </div>
    </div>
    <button class="btn primary full" id="add-symbol-confirm">確認新增</button>
  `);

  const input = document.getElementById("add-symbol-input");
  input.focus();

  document.getElementById("add-symbol-confirm").addEventListener("click", async () => {
    const symbol = input.value.trim().toUpperCase();
    if (!symbol) { showToast("請輸入代碼"); return; }

    const btn = document.getElementById("add-symbol-confirm");
    btn.disabled = true;
    btn.textContent = "新增中…";
    try {
      await api.post("/api/watchlist", { symbol });
      closeSheet();
      showToast(`已新增 ${symbol}`);
      const container = document.getElementById("page-watchlist");
      await renderWatchlist(container);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        showToast("已在自選清單中");
      } else {
        showToast("新增失敗，請確認代碼");
      }
      btn.disabled = false;
      btn.textContent = "確認新增";
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("add-symbol-confirm").click();
  });
}
