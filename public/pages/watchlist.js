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

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function renderWatchlist(container) {
  container.innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <h2 style="margin:0">自選清單</h2>
      <div style="display:flex;gap:8px">
        <button class="btn secondary" id="wl-scan-btn" style="padding:8px 12px">⚡ 掃描</button>
        <button class="btn secondary" id="wl-add-btn" style="padding:8px 12px">＋ 新增</button>
      </div>
    </div>
    <div id="wl-scan-results"></div>
    <div id="wl-list"><div class="empty"><div class="spinner"></div></div></div>
  `;

  document.getElementById("wl-add-btn").addEventListener("click", openAddSheet);
  document.getElementById("wl-scan-btn").addEventListener("click", () => runScan(container));
  await loadList(container);
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
  let badge = `<span class="badge muted">無訊號</span>`;
  if (sig?.signal === "golden_cross") {
    badge = `<span class="badge green">▲ 黃金交叉</span>`;
  } else if (sig?.signal === "death_cross") {
    badge = `<span class="badge red">▼ 死亡交叉</span>`;
  }

  const sigDate = sig?.signal_date
    ? `<span class="text-sm text-muted">${String(sig.signal_date).slice(0, 10)}</span>`
    : "";

  return `
    <div class="card wl-row" data-symbol="${item.symbol}" style="cursor:pointer">
      <div class="row">
        <div>
          <div style="font-weight:700;font-size:16px">${esc(item.symbol)}</div>
          ${sigDate}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${badge}
          <button class="btn danger wl-delete" data-id="${item.id}" style="padding:6px 10px;font-size:12px">移除</button>
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

  let badge = `<span class="badge muted">無訊號</span>`;
  if (item.signal === "golden_cross") badge = `<span class="badge green">▲ 黃金交叉</span>`;
  if (item.signal === "death_cross")  badge = `<span class="badge red">▼ 死亡交叉</span>`;

  const conf = item.confidence === "high"
    ? `<span class="text-sm" style="color:var(--yellow)">高信心</span>`
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
