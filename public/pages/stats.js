/**
 * pages/stats.js — Win rate statistics by signal type
 *
 * Tab: 統計
 * Pulls /api/trades/stats and renders stat cards grouped by signal_type.
 */

import { api } from "../api.js";

export async function renderStats(container) {
  container.innerHTML = `
    <h2>歷史統計</h2>
    <div id="stats-body"><div class="empty"><div class="spinner"></div></div></div>
  `;
  await loadStats(container);
}

async function loadStats(container) {
  const body = container.querySelector("#stats-body");
  try {
    const result = await api.get("/api/trades/stats");

    // Backend returns { total, bySignal }
    const overall  = result.total;
    const bySignal = result.bySignal ?? {};

    if (!overall || overall.count === 0) {
      body.innerHTML = `<div class="empty">尚無已結清的交易紀錄<br>在交易頁填入出場價格後統計會出現</div>`;
      return;
    }

    let html = "";

    // Overall summary
    html += `
      <div class="card" style="margin-bottom:16px">
        <div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:10px">總覽</div>
        <div class="stat-grid">
          ${statCard("總交易次數", overall.count, "")}
          ${statCard("勝率", pct(overall.winRate), "", winColor(overall.winRate))}
          ${statCard("平均報酬", pct(overall.avgReturn), "", returnColor(overall.avgReturn))}
          ${statCard("最大獲利", pct(overall.maxWin), "", "var(--green)")}
        </div>
        <div class="stat-grid" style="margin-top:8px">
          ${statCard("最大虧損", pct(overall.maxLoss), "", "var(--red)")}
          ${statCard("已結清", overall.closed, "")}
          ${statCard("持倉中", overall.open, "")}
          ${statCard("", "", "")}
        </div>
      </div>
    `;

    // Per-group breakdown
    const groupOrder = ["golden_cross", "death_cross", "manual"];
    const groupLabel = {
      golden_cross: "▲ 黃金交叉訊號",
      death_cross:  "▼ 死亡交叉訊號",
      manual:       "手動記錄",
    };

    for (const key of groupOrder) {
      const g = bySignal[key];
      if (!g || g.count === 0) continue;
      const isGolden = key === "golden_cross";
      const isDeath  = key === "death_cross";
      const accent   = isGolden ? "var(--green)" : isDeath ? "var(--red)" : "var(--muted)";

      html += `
        <div class="card">
          <div style="font-size:12px;color:${accent};font-weight:600;margin-bottom:10px">${groupLabel[key]}</div>
          <div class="stat-grid">
            ${statCard("交易次數", g.count, "")}
            ${statCard("勝率", pct(g.winRate), "", winColor(g.winRate))}
            ${statCard("平均報酬", pct(g.avgReturn), "", returnColor(g.avgReturn))}
            ${statCard("最大獲利", pct(g.maxWin), "", "var(--green)")}
          </div>
          <div class="stat-grid" style="margin-top:8px">
            ${statCard("最大虧損", pct(g.maxLoss), "", "var(--red)")}
            ${statCard("已結清", g.closed, "")}
            <div></div><div></div>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  } catch {
    body.innerHTML = `<div class="empty">載入失敗，請稍後再試</div>`;
  }
}

function statCard(label, value, unit, color = "var(--text)") {
  const display = value === "" ? "—" : `${value}${unit}`;
  return `
    <div class="stat-card">
      <div class="text-sm text-muted">${label}</div>
      <div class="val" style="color:${color}">${display}</div>
    </div>
  `;
}

function pct(n) {
  // NaN serializes as null in JSON
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  if (!isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function winColor(rate) {
  if (rate == null) return "var(--text)";
  return rate >= 50 ? "var(--green)" : "var(--red)";
}

function returnColor(avg) {
  if (avg == null) return "var(--text)";
  return avg >= 0 ? "var(--green)" : "var(--red)";
}
