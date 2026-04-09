/**
 * pages/watchlist.js — Watchlist page
 *
 * Shows user's watched symbols with current signal badge.
 * Tap a row → switches to chart tab for that symbol.
 * + button → bottom sheet to add a new symbol.
 */

import { api, ApiError } from "../api.js";
import { showToast, openSheet, closeSheet, navigate } from "../app.js";

export async function renderWatchlist(container) {
  container.innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <h2 style="margin:0">自選清單</h2>
      <button class="btn secondary" id="wl-add-btn" style="padding:8px 12px">＋ 新增</button>
    </div>
    <div id="wl-list"><div class="empty"><div class="spinner"></div></div></div>
  `;

  document.getElementById("wl-add-btn").addEventListener("click", openAddSheet);
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
        } catch (err) {
          showToast("移除失敗");
        }
      });
    });
  } catch (err) {
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
    ? `<span class="text-sm text-muted">${sig.signal_date}</span>`
    : "";

  return `
    <div class="card wl-row" data-symbol="${item.symbol}" style="cursor:pointer">
      <div class="row">
        <div>
          <div style="font-weight:700;font-size:16px">${item.symbol}</div>
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

    try {
      await api.post("/api/watchlist", { symbol });
      closeSheet();
      showToast(`已新增 ${symbol}`);
      // Re-render the whole page to refresh list
      const container = document.getElementById("page-watchlist");
      await renderWatchlist(container);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        showToast("已在自選清單中");
      } else {
        showToast("新增失敗，請確認代碼");
      }
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("add-symbol-confirm").click();
  });
}
