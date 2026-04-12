/**
 * pages/trades.js — Open positions + closed trades with P&L display
 *
 * Tab: 交易
 * - Lists open positions (no exit price) at top
 * - Lists closed trades with P&L % below
 * - Tap open position → bottom sheet to fill in exit price
 */

import { api, ApiError } from "../api.js";
import { showToast, openSheet, closeSheet } from "../app.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function renderTrades(container) {
  container.innerHTML = `
    <h2>交易紀錄</h2>
    <div id="trades-list"><div class="empty"><div class="spinner"></div></div></div>
  `;
  await loadTrades(container);
}

async function loadTrades(container) {
  const listEl = container.querySelector("#trades-list");
  try {
    const trades = await api.get("/api/trades");
    if (!trades.length) {
      listEl.innerHTML = `<div class="empty">尚無交易紀錄<br>在圖表頁點選標的後記錄交易</div>`;
      return;
    }

    const open   = trades.filter((t) => !t.exit_price);
    const closed = trades.filter((t) =>  t.exit_price);

    let html = "";

    if (open.length) {
      html += `<div style="font-size:12px;color:var(--muted);margin-bottom:8px;font-weight:600">持倉中</div>`;
      html += open.map(renderOpenRow).join("");
    }

    if (closed.length) {
      html += `<div style="font-size:12px;color:var(--muted);margin:16px 0 8px;font-weight:600">已結清</div>`;
      html += closed.map(renderClosedRow).join("");
    }

    listEl.innerHTML = html;

    // Tap open trade → fill exit
    listEl.querySelectorAll(".trade-open-row").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.id;
        const trade = open.find((t) => String(t.id) === id);
        if (trade) openExitSheet(trade, container);
      });
    });

    // Delete button on closed trades
    listEl.querySelectorAll(".trade-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await api.delete(`/api/trades/${btn.dataset.id}`);
          showToast("已刪除");
          await loadTrades(container);
        } catch {
          showToast("刪除失敗");
        }
      });
    });
  } catch {
    listEl.innerHTML = `<div class="empty">載入失敗，請稍後再試</div>`;
  }
}

function renderOpenRow(t) {
  const dirLabel = t.direction === "long" ? "做多" : "做空";
  const dirColor = t.direction === "long" ? "green" : "red";

  return `
    <div class="card trade-open-row" data-id="${t.id}" style="cursor:pointer">
      <div class="row">
        <div>
          <span style="font-weight:700">${esc(t.symbol)}</span>
          <span class="badge ${dirColor}" style="margin-left:6px">${dirLabel}</span>
        </div>
        <span class="text-muted text-sm">持倉中 ›</span>
      </div>
      <div class="divider"></div>
      <div class="row text-sm">
        <span class="text-muted">進場日期</span><span>${isoToDate(t.entry_date)}</span>
      </div>
      <div class="row text-sm" style="margin-top:4px">
        <span class="text-muted">進場價格</span><span>${fmt(t.entry_price)}</span>
      </div>
      ${t.notes ? `<div class="text-sm text-muted" style="margin-top:6px">${esc(t.notes)}</div>` : ""}
    </div>
  `;
}

function renderClosedRow(t) {
  const pnlPct = calcPnl(t);
  // calcPnl already flips the sign for shorts, so positive = profit for all directions
  const isWin  = pnlPct !== null && pnlPct >= 0;
  const pnlEl  = pnlPct !== null
    ? `<span class="${isWin ? "text-green" : "text-red"}" style="font-weight:700;font-size:15px">${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%</span>`
    : "";

  const dirLabel = t.direction === "long" ? "做多" : "做空";
  const dirColor = t.direction === "long" ? "green" : "red";

  return `
    <div class="card">
      <div class="row">
        <div>
          <span style="font-weight:700">${esc(t.symbol)}</span>
          <span class="badge ${dirColor}" style="margin-left:6px">${dirLabel}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${pnlEl}
          <button class="btn danger trade-delete-btn" data-id="${t.id}" style="padding:4px 8px;font-size:11px">刪除</button>
        </div>
      </div>
      <div class="divider"></div>
      <div class="row text-sm">
        <span class="text-muted">進場</span>
        <span>${isoToDate(t.entry_date)} @ ${fmt(t.entry_price)}</span>
      </div>
      <div class="row text-sm" style="margin-top:4px">
        <span class="text-muted">出場</span>
        <span>${isoToDate(t.exit_date)} @ ${fmt(t.exit_price)}</span>
      </div>
      ${t.notes ? `<div class="text-sm text-muted" style="margin-top:6px">${esc(t.notes)}</div>` : ""}
    </div>
  `;
}

function calcPnl(t) {
  if (t.entry_price == null || t.exit_price == null) return null;
  const raw = ((t.exit_price - t.entry_price) / t.entry_price) * 100;
  return t.direction === "short" ? -raw : raw;
}

function fmt(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function isoToDate(s) {
  if (!s) return "—";
  return String(s).slice(0, 10);
}

function openExitSheet(trade, container) {
  const today = new Date().toISOString().slice(0, 10);
  openSheet(`
    <h3>結清交易 — ${trade.symbol}</h3>
    <div class="card" style="margin-bottom:12px">
      <div class="row text-sm">
        <span class="text-muted">進場價格</span><span>${fmt(trade.entry_price)}</span>
      </div>
      <div class="row text-sm" style="margin-top:4px">
        <span class="text-muted">進場日期</span><span>${trade.entry_date}</span>
      </div>
    </div>
    <div class="field">
      <label>出場日期</label>
      <input type="date" id="exit-date" value="${today}" />
    </div>
    <div class="field">
      <label>出場價格</label>
      <input type="number" id="exit-price" placeholder="出場價" step="any" />
    </div>
    <div class="field">
      <label>備註</label>
      <textarea id="exit-notes" rows="2" placeholder="（選填）"></textarea>
    </div>
    <div id="exit-pnl-preview" style="margin-bottom:12px;text-align:center;font-size:18px;font-weight:700"></div>
    <button class="btn primary full" id="exit-confirm-btn">確認結清</button>
  `);

  const exitPriceInput = document.getElementById("exit-price");
  const pnlPreview     = document.getElementById("exit-pnl-preview");

  exitPriceInput.addEventListener("input", () => {
    const exitPrice = parseFloat(exitPriceInput.value);
    if (isNaN(exitPrice) || !trade.entry_price) { pnlPreview.innerHTML = ""; return; }
    const raw = ((exitPrice - trade.entry_price) / trade.entry_price) * 100;
    const pct = trade.direction === "short" ? -raw : raw;
    const color = pct >= 0 ? "var(--green)" : "var(--red)";
    pnlPreview.innerHTML = `<span style="color:${color}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
  });

  document.getElementById("exit-confirm-btn").addEventListener("click", async () => {
    const exitDate  = document.getElementById("exit-date").value;
    const exitPrice = parseFloat(exitPriceInput.value);
    const notes     = document.getElementById("exit-notes").value.trim();

    if (!exitDate || isNaN(exitPrice)) {
      showToast("請填入日期與出場價格");
      return;
    }

    const btn = document.getElementById("exit-confirm-btn");
    btn.disabled = true;
    btn.textContent = "結清中…";
    try {
      await api.put(`/api/trades/${trade.id}`, {
        exit_date:  exitDate,
        exit_price: exitPrice,
        notes: notes || undefined,
      });
      closeSheet();
      showToast("已結清");
      await loadTrades(container);
    } catch {
      showToast("更新失敗，請稍後再試");
      btn.disabled = false;
      btn.textContent = "確認結清";
    }
  });
}
