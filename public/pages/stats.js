/**
 * pages/stats.js — Win rate statistics by signal type
 *
 * Tab: 統計
 * Pulls /api/trades/stats and renders stat cards grouped by signal_type.
 */

import { api } from "../api.js";
import { showToast } from "../app.js";

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

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
        <div class="section-label" style="margin-bottom:6px">總覽</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">所有交易的整體表現</div>
        <div class="stat-grid">
          ${statCard("總交易次數", overall.count, "")}
          ${statCard("勝率", pct(overall.winRate, false), "", winColor(overall.winRate))}
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
    const groupDesc = {
      golden_cross: "MA25 由下往上穿越 MA60，視為買入訊號。這些是因黃金交叉而進場的交易。",
      death_cross:  "MA25 由上往下穿越 MA60，視為賣出／做空訊號。這些是因死亡交叉而進場的交易。",
      manual:       "未連結訊號、手動記錄的交易。",
    };

    for (const key of groupOrder) {
      const g = bySignal[key];
      if (!g || g.count === 0) continue;
      const isGolden = key === "golden_cross";
      const isDeath  = key === "death_cross";
      const accent   = isGolden ? "var(--green)" : isDeath ? "var(--red)" : "var(--muted)";

      html += `
        <div class="card">
          <div class="section-label" style="color:${accent};margin-bottom:6px">${groupLabel[key]}</div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:10px">${groupDesc[key]}</div>
          <div class="stat-grid">
            ${statCard("交易次數", g.count, "")}
            ${statCard("勝率", pct(g.winRate, false), "", winColor(g.winRate))}
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
    bindTips(body);

    // Append signal outcomes section (best-effort — no spinner)
    loadOutcomes(body);
  } catch {
    body.innerHTML = `<div class="empty">載入失敗，請稍後再試</div>`;
  }
}

async function loadOutcomes(container) {
  try {
    const { outcomes } = await api.get("/api/signals/outcomes");
    if (!outcomes?.length) return;

    const fmtPct = v => v != null ? (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%" : "—";
    const fmtRet = v => v != null ? (v >= 0 ? "+" : "") + v.toFixed(1) + "%" : "—";
    const winColor = v => v == null ? "var(--text)" : v >= 0.5 ? "var(--green)" : "var(--red)";

    const rows = outcomes.map(o => {
      const isGolden = o.signal === "golden_cross";
      const label    = isGolden ? "▲ 黃金交叉" : "▼ 死亡交叉";
      const accent   = isGolden ? "var(--green)" : "var(--red)";
      return `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">
          <div class="row" style="margin-bottom:8px">
            <span style="font-weight:600;font-size:13px">${esc(o.symbol)}</span>
            <span style="color:${accent};font-size:12px;font-weight:600">${label}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
            ${outcomeCell("5日", fmtPct(o.win_rate_5d), fmtRet(o.avg_return_5d), winColor(o.win_rate_5d))}
            ${outcomeCell("10日", fmtPct(o.win_rate_10d), fmtRet(o.avg_return_10d), winColor(o.win_rate_10d))}
            ${outcomeCell("20日", fmtPct(o.win_rate_20d), fmtRet(o.avg_return_20d), winColor(o.win_rate_20d))}
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:6px">${o.count} 筆已計算</div>
        </div>`;
    }).join("");

    const section = document.createElement("div");
    section.innerHTML = `
      <div class="card" style="margin-top:8px">
        <div class="section-label" style="margin-bottom:6px">訊號績效追蹤</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:12px">
          訊號觸發後 N 個交易日的勝率與平均報酬（由每日自動計算）
        </div>
        ${rows}
      </div>`;
    container.appendChild(section);
  } catch {
    // outcomes are non-critical — fail silently
  }
}

function outcomeCell(period, winRate, avgRet, color) {
  return `
    <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:8px;text-align:center">
      <div style="font-size:10px;color:var(--muted);margin-bottom:4px">${period}</div>
      <div style="font-weight:700;font-size:13px;color:${color}">${winRate}</div>
      <div style="font-size:11px;color:var(--muted)">${avgRet}</div>
    </div>`;
}

const TERM_TIPS = {
  "勝率":     "已結清的交易中，獲利筆數佔總筆數的比例。50% 以上代表超過一半的交易有獲利。",
  "平均報酬": "每筆已結清交易的平均報酬率（出場價 ÷ 進場價 − 1）。正數代表平均有獲利。",
  "最大獲利": "所有已結清交易中，單筆最高的報酬率。",
  "最大虧損": "所有已結清交易中，單筆最大的虧損率（負數）。",
  "總交易次數": "包含未結清（持倉中）和已結清的所有交易筆數。",
  "已結清": "已填入出場價格的交易，可計算實際損益。",
  "持倉中": "尚未填入出場價格的交易，損益待計算。",
};

function statCard(label, value, unit, color = "var(--text)") {
  const display = value === "" ? "—" : `${value}${unit}`;
  const tip = TERM_TIPS[label];
  const tipBtn = tip
    ? `<span class="stat-tip" data-tip="${label}" style="color:var(--muted);font-size:11px;cursor:pointer;margin-left:3px">ⓘ</span>`
    : "";
  return `
    <div class="stat-card">
      <div class="text-sm text-muted">${label}${tipBtn}</div>
      <div class="val" style="color:${color}">${display}</div>
    </div>
  `;
}

function bindTips(container) {
  container.querySelectorAll(".stat-tip").forEach(el => {
    el.addEventListener("click", e => {
      e.stopPropagation();
      showToast(TERM_TIPS[el.dataset.tip] ?? "", 4000);
    });
  });
}

// For returns: show sign (±). For rates like win rate: no sign.
function pct(n, signed = true) {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  if (!isFinite(v)) return "—";
  return `${signed && v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function winColor(rate) {
  if (rate == null) return "var(--text)";
  return rate >= 50 ? "var(--green)" : "var(--red)";
}

function returnColor(avg) {
  if (avg == null) return "var(--text)";
  return avg >= 0 ? "var(--green)" : "var(--red)";
}
