/**
 * app.js — SPA entry point
 *
 * Responsibilities:
 *  - Initialize the platform (LINE / Telegram / dev)
 *  - Tab navigation + page rendering
 *  - Shared UI helpers: showToast, openSheet, closeSheet, navigate
 */

import { initPlatform } from "./platform.js";
import { renderWatchlist } from "./pages/watchlist.js";
import { renderChart }     from "./pages/chart.js";
import { renderTrades }    from "./pages/trades.js";
import { renderStats }     from "./pages/stats.js";
import { renderReminders } from "./pages/reminders.js";

// ── State ─────────────────────────────────────────────────────────
let activeTab = "watchlist";
// Track whether each page has ever been rendered (lazy)
const rendered = {};

// ── Page renderers map ────────────────────────────────────────────
const renderers = {
  watchlist: renderWatchlist,
  chart:     renderChart,
  trades:    renderTrades,
  stats:     renderStats,
  reminders: renderReminders,
};

// ── Boot ──────────────────────────────────────────────────────────
async function boot() {
  try {
    await initPlatform();
  } catch (e) {
    console.error("Platform init failed", e);
    showToast("平台初始化失敗，請重新載入");
    return;
  }

  setupTabs();

  // Deep-link: ?symbol=2330.TW navigates directly to chart
  const urlSymbol = new URLSearchParams(window.location.search).get("symbol");
  if (urlSymbol) {
    // Strip the query param before rendering so back/refresh doesn't re-trigger
    history.replaceState(null, "", window.location.pathname);
    await switchTab("chart", { symbol: urlSymbol });
  } else {
    await switchTab("watchlist");
  }
}

// ── Tab navigation ────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
}

async function switchTab(name, params) {
  if (!renderers[name]) return;

  // Update active tab UI
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".page").forEach((p) => {
    p.classList.toggle("active", p.id === `page-${name}`);
  });

  activeTab = name;
  const container = document.getElementById(`page-${name}`);

  // For chart, always re-render if params provided (symbol changed)
  if (name === "chart" && params) {
    await safeRender(name, container, params);
    return;
  }

  // For other pages, lazy render: only re-render if not yet rendered.
  // Exception: trades and stats always refresh (data changes frequently).
  const alwaysRefresh = ["watchlist", "trades", "stats", "reminders"];
  if (!rendered[name] || alwaysRefresh.includes(name)) {
    await safeRender(name, container, params);
  }
}

async function safeRender(name, container, params) {
  try {
    await renderers[name](container, params);
    rendered[name] = true;
  } catch (e) {
    console.error(`Render error on ${name}`, e);
    container.innerHTML = `<div class="empty">頁面載入失敗，請重新整理</div>`;
  }
}

// ── Navigate (called by page modules) ────────────────────────────
export function navigate(tab, params) {
  switchTab(tab, params);
}

// ── Toast ─────────────────────────────────────────────────────────
let toastTimer = null;
export function showToast(msg, duration = 2000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

// ── Bottom sheet ──────────────────────────────────────────────────
export function openSheet(html) {
  const overlay = document.getElementById("sheet-overlay");
  const content = document.getElementById("sheet-content");
  content.innerHTML = html;
  overlay.classList.add("open");

  // Close on overlay backdrop click
  overlay.onclick = (e) => {
    if (e.target === overlay) closeSheet();
  };
}

export function closeSheet() {
  document.getElementById("sheet-overlay").classList.remove("open");
}

// ── Start ─────────────────────────────────────────────────────────
boot();
