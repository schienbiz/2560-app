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

export async function renderReminders(container) {
  container.innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <h2 style="margin:0">提醒清單</h2>
      <button class="btn secondary" id="rem-add-btn" style="padding:8px 12px">＋ 新增</button>
    </div>
    <div id="rem-list"><div class="empty"><div class="spinner"></div></div></div>
  `;
  document.getElementById("rem-add-btn").addEventListener("click", () => openAddSheet(container));
  await loadReminders(container);
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
    const today = new Date().toISOString().slice(0, 10);
    let html = items.map((r) => renderRow(r, today)).join("");

    listEl.innerHTML = html;

    listEl.querySelectorAll(".rem-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await api.delete(`/api/reminders/${btn.dataset.id}`);
          showToast("已刪除");
          await loadReminders(container);
        } catch {
          showToast("刪除失敗");
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
          <span style="font-weight:700">${r.symbol || "—"}</span>
          <span style="font-size:12px;color:${dateColor};margin-left:8px">${dateLabel}</span>
        </div>
        <button class="btn danger rem-delete-btn" data-id="${r.id}" style="padding:4px 10px;font-size:11px">刪除</button>
      </div>
      ${r.note ? `<div class="text-sm text-muted" style="margin-top:6px">${r.note}</div>` : ""}
    </div>
  `;
}

function openAddSheet(container) {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

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
