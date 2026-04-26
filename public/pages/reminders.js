/**
 * pages/reminders.js — Upcoming reminders list + add reminder form
 *
 * Tab: 提醒
 * Shows future (and today's) reminders sorted by date.
 * Each row has a delete button.
 * + button at top opens the add sheet.
 */

import { api } from "../api.js";
import { showToast, openSheet, closeSheet } from "../app.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function renderReminders(container) {
  container.innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <h2 style="margin:0">提醒清單</h2>
      <button class="btn secondary" id="rem-add-btn" style="padding:8px 12px">＋ 新增</button>
    </div>
    <div id="rem-list"><div class="empty"><div class="spinner"></div></div></div>
    <h2 style="margin-top:24px;margin-bottom:12px">提醒歷史</h2>
    <div id="sig-list"><div class="empty"><div class="spinner"></div></div></div>
  `;
  document.getElementById("rem-add-btn").addEventListener("click", () => openAddSheet(container));
  await Promise.all([loadReminders(container), loadSignalHistory(container)]);
}

function taipeiToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

async function loadReminders(container) {
  const listEl = container.querySelector("#rem-list");
  try {
    const items = await api.get("/api/reminders");
    if (!items.length) {
      listEl.innerHTML = `<div class="empty">尚無提醒<br>在圖表頁或點擊右上角「＋ 新增」設定提醒</div>`;
      return;
    }

    // Backend already filters to upcoming reminders only
    const today = taipeiToday();
    let html = items.map((r) => renderRow(r, today)).join("");

    listEl.innerHTML = html;

    listEl.querySelectorAll(".rem-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await api.delete(`/api/reminders/${btn.dataset.id}`);
          showToast("已刪除");
          await loadReminders(container);
        } catch {
          showToast("刪除失敗");
          btn.disabled = false;
        }
      });
    });
  } catch {
    listEl.innerHTML = `<div class="empty">載入失敗，請稍後再試</div>`;
  }
}

function renderRow(r, today) {
  const dateStr    = String(r.remind_date).slice(0, 10);
  const isToday    = dateStr === today;
  const isPast     = dateStr < today;
  const dateColor  = isToday ? "var(--yellow)" : isPast ? "var(--muted)" : "var(--text)";
  const dateLabel  = isToday ? "今天" : dateStr;

  return `
    <div class="card">
      <div class="row">
        <div>
          <span style="font-weight:700">${esc(r.symbol) || "—"}</span>
          <span style="font-size:12px;color:${dateColor};margin-left:8px">${dateLabel}</span>
        </div>
        <button class="btn danger rem-delete-btn" data-id="${r.id}" style="padding:4px 10px;font-size:11px">刪除</button>
      </div>
      ${r.note ? `<div class="text-sm text-muted" style="margin-top:6px">${esc(r.note)}</div>` : ""}
    </div>
  `;
}

async function loadSignalHistory(container) {
  const listEl = container.querySelector("#sig-list");
  try {
    const data = await api.get("/api/signals?limit=30");
    const signals = data.signals ?? [];
    if (!signals.length) {
      listEl.innerHTML = `<div class="empty">尚無提醒紀錄</div>`;
      return;
    }
    listEl.innerHTML = signals.map(renderSignalRow).join("");
  } catch {
    listEl.innerHTML = `<div class="empty">載入失敗，請稍後再試</div>`;
  }
}

function renderSignalRow(s) {
  const LABELS = {
    golden_cross:    { icon: "🟢", text: "黃金交叉" },
    death_cross:     { icon: "🔴", text: "死亡交叉" },
    proximity_golden:{ icon: "📍", text: "接近進場區" },
    proximity_exit:  { icon: "🔔", text: "離開進場區" },
    none:            { icon: "—",  text: "無訊號" },
  };
  const { icon, text } = LABELS[s.signal] ?? { icon: "•", text: esc(s.signal) };
  const dateStr = String(s.signal_date).slice(0, 10);
  const conf    = s.confidence === "high" ? " 高信心度" : s.confidence === "medium" ? " 中信心度" : "";

  function outcomeBadge(pct, label) {
    if (pct == null) return "";
    const color = pct >= 0 ? "var(--green)" : "var(--red)";
    const sign  = pct >= 0 ? "+" : "";
    return `<span class="badge-compact" style="color:${color}">${label} ${sign}${pct.toFixed(1)}%</span>`;
  }

  const hasCrossSignal = (s.signal === "golden_cross" || s.signal === "death_cross");
  const hasAnyOutcome  = (s.outcome_5d != null || s.outcome_10d != null || s.outcome_20d != null);
  const signalAgeMs    = Date.now() - new Date(s.signal_date).getTime();
  const isPending      = hasCrossSignal && !hasAnyOutcome && signalAgeMs < 28 * 24 * 60 * 60 * 1000;

  const outcomes = hasAnyOutcome
    ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:5px">
        ${outcomeBadge(s.outcome_5d, "5天")}
        ${outcomeBadge(s.outcome_10d, "10天")}
        ${outcomeBadge(s.outcome_20d, "20天")}
       </div>`
    : isPending
    ? `<div class="text-sm text-muted" style="margin-top:4px;font-style:italic">結果計算中 · 訊號後 5–10 交易日更新</div>`
    : "";

  return `
    <div class="card">
      <div class="row">
        <div>
          <span style="font-weight:700">${esc(s.symbol)}</span>
          <span style="margin-left:6px">${icon} ${text}${conf}</span>
        </div>
        <span class="text-sm text-muted">${esc(dateStr)}</span>
      </div>
      <div class="text-sm text-muted" style="margin-top:4px">
        收盤 ${s.close_price?.toLocaleString() ?? "—"}
        ・MA25 ${s.ma25?.toFixed(2) ?? "—"}
        ・MA60 ${s.ma60?.toFixed(2) ?? "—"}
      </div>
      ${outcomes}
    </div>
  `;
}

function openAddSheet(container) {
  const d = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" }));
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);

  openSheet(`
    <h3>新增提醒</h3>
    <div class="field">
      <label>標的代碼</label>
      <input id="rem-symbol" placeholder="例：2330 / BTCUSDT" autocapitalize="characters" />
    </div>
    <div class="field">
      <label>提醒日期</label>
      <input type="date" id="rem-date" value="${tomorrow}" />
    </div>
    <div class="field">
      <label>提醒內容</label>
      <textarea id="rem-note" rows="3" placeholder="例：確認突破壓力區、重新評估趨勢…"></textarea>
    </div>
    <button class="btn primary full" id="rem-confirm-btn">確認新增</button>
  `);

  document.getElementById("rem-confirm-btn").addEventListener("click", async () => {
    const symbol = document.getElementById("rem-symbol").value.trim().toUpperCase();
    const date   = document.getElementById("rem-date").value;
    const note   = document.getElementById("rem-note").value.trim() || undefined;

    if (!symbol) { showToast("請輸入標的代碼"); return; }
    if (!date) { showToast("請選擇日期"); return; }

    const btn = document.getElementById("rem-confirm-btn");
    btn.disabled = true;
    btn.textContent = "新增中…";
    try {
      await api.post("/api/reminders", { symbol, remind_date: date, note });
      closeSheet();
      showToast("提醒已設定");
      await loadReminders(container);
    } catch {
      showToast("新增失敗，請稍後再試");
      btn.disabled = false;
      btn.textContent = "確認新增";
    }
  });
}
