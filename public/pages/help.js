/**
 * pages/help.js — 使用者說明手冊（內嵌版）
 *
 * Tab: 說明
 * 折疊式章節，點擊標題展開/收合內容。
 */

const SECTIONS = [
  {
    title: "什麼是 2560 戰法",
    content: `
      <p>利用 <strong>快線 MA25</strong>（25 日移動平均）與 <strong>慢線 MA60</strong>（60 日移動平均）的相對位置，判斷趨勢方向與進出場時機。</p>
      <table>
        <tr><th>訊號</th><th>條件</th><th>意義</th></tr>
        <tr><td>▲ 黃金交叉</td><td>MA25 由下往上穿越 MA60</td><td>趨勢轉多，買入訊號</td></tr>
        <tr><td>▼ 死亡交叉</td><td>MA25 由上往下穿越 MA60</td><td>趨勢轉空，賣出訊號</td></tr>
        <tr><td>無訊號</td><td>兩線未發生穿越</td><td>觀望，等待訊號確認</td></tr>
      </table>
      <p>均線 = 過去 N 天收盤價的算術平均值，反映中期趨勢方向。</p>
    `,
  },
  {
    title: "登入方式",
    content: `
      <p>本工具透過 <strong>LINE</strong> 或 <strong>Telegram</strong> 帳號驗證身份，不需另外申請帳號密碼。</p>
      <ul>
        <li><strong>LINE</strong>：在 LINE 中開啟連結，系統自動識別帳號</li>
        <li><strong>Telegram</strong>：透過 Telegram Bot 開啟，或手動輸入 Bot 的驗證碼</li>
      </ul>
    `,
  },
  {
    title: "自選清單",
    content: `
      <p>主頁面。顯示你追蹤的所有標的及最新訊號狀態。</p>
      <h4>新增標的</h4>
      <p>點擊右上角 <strong>＋ 新增</strong> → 輸入代碼 → 確認新增。</p>
      <table>
        <tr><th>資產類型</th><th>代碼格式</th><th>範例</th></tr>
        <tr><td>台股</td><td>純數字</td><td>2330、0050</td></tr>
        <tr><td>美股</td><td>英文代碼</td><td>AAPL、TSLA</td></tr>
        <tr><td>加密貨幣</td><td>交易對</td><td>BTCUSDT、ETHUSDT</td></tr>
      </table>
      <h4>立即掃描</h4>
      <p>點擊 <strong>⚡ 掃描</strong> 對所有標的重新計算訊號，顯示目前交叉狀態、信心度標記。</p>
      <h4>設定標的 ⚙</h4>
      <ul>
        <li><strong>均線組合</strong>：5/20、25/60（預設）、50/200，或自訂數值</li>
        <li><strong>通知</strong>：開關黃金/死亡交叉通知、暫停此標的</li>
        <li><strong>顯示名稱</strong>：自訂標籤，如「台積電」</li>
        <li><strong>接近快線警示門檻</strong>：價格進入 MA 快線附近時通知（預設 1.5%）</li>
      </ul>
    `,
  },
  {
    title: "圖表與分析",
    content: `
      <h4>三層圖表</h4>
      <p>拖動任一區塊時間軸，其他兩個同步移動。</p>
      <ul>
        <li><strong>① K 線 + 均線</strong>（主圖）：近 120 天 K 線、MA 快線（藍）、MA 慢線（橘）、擺動結構標記</li>
        <li><strong>② RSI(14)</strong>：相對強弱指數，參考線 70（超買）/ 50（中性）/ 30（超賣）</li>
        <li><strong>③ MACD(12/26/9)</strong>：柱狀圖（綠=多頭動能，紅=空頭動能）、MACD 線（藍）、訊號線（橘）</li>
      </ul>
      <h4>訊號信心度（4 因子）</h4>
      <table>
        <tr><th>因子</th><th>達標條件</th></tr>
        <tr><td>成交量確認</td><td>當日成交量 &gt; 10 日均量 × 1.2</td></tr>
        <tr><td>價格貼近均線</td><td>收盤價在 MA 慢線 ±15% 以內</td></tr>
        <tr><td>RSI 方向確認</td><td>黃金交叉 RSI &gt; 50；死亡交叉 RSI &lt; 50</td></tr>
        <tr><td>MACD 動能確認</td><td>黃金交叉柱狀 &gt; 0；死亡交叉柱狀 &lt; 0</td></tr>
      </table>
      <p>3–4 分 = <strong style="color:var(--green)">高信心</strong>　2 分 = 中信心　0–1 分 = 低信心</p>
      <h4>AI 分析（多模型交叉校正）</h4>
      <p>點擊 <strong>✦ AI 分析</strong> — 系統同時向多個 AI 模型查詢，交叉比對後合成更精準的分析。若各模型出現明顯分歧，開頭會標示 <strong>⚠ 分析有分歧：</strong>。</p>
      <p>分析包含六點結構化輸出：</p>
      <table>
        <tr><th>分析點</th><th>內容</th></tr>
        <tr><td>① 趨勢階段</td><td>impulse 推進 / correction 回調 / range 盤整，含 MA 斜率方向</td></tr>
        <tr><td>② 價格結構</td><td>HH/HL/LH/LL 擺動點描述，多空控盤判斷</td></tr>
        <tr><td>③ 量價關係</td><td>成交量倍數（V×N vs 10日均量），放量突破或縮量回調</td></tr>
        <tr><td>④ 動能確認</td><td>RSI 超買/超賣、MACD 柱狀多空方向</td></tr>
        <tr><td>⑤ 進場區與操作</td><td>MA 快線 ±1% 進場區、入場條件，含歷史勝率參考</td></tr>
        <tr><td>⑥ 偏向與失效條件</td><td>看多/看空/觀望核心理由，以及哪個收盤價位使偏向失效</td></tr>
      </table>
      <p>訊號年齡：AI 會標示交叉發生幾天前（如「10天前」），讓你判斷訊號是否仍在有效進場窗口內。</p>
      <p>歷史勝率：若此標的有過去的黃金/死亡交叉紀錄且已計算報酬，AI 會在分析中列出「10日勝率 4/5（80%），均+9.3%」等統計，供操作參考。</p>
    `,
  },
  {
    title: "回測",
    content: `
      <p>在圖表頁點擊 <strong>📊 回測</strong>，用歷史 K 線模擬 2560戰法的實際績效。右上角可切換 <strong>1年 / 2年</strong>。</p>
      <p><strong>進出場規則：</strong>進場 = 黃金交叉收盤價；出場 = 死亡交叉收盤價。不含手續費與滑價。</p>
      <p>回測使用你在自選清單中為此標的設定的 <strong>均線組合</strong>（例如 MA5/MA20 或 MA50/MA200），與即時掃描和通知保持一致。從自選清單進入圖表時，均線設定會自動帶入。</p>

      <table>
        <tr><th>指標</th><th>說明</th></tr>
        <tr><td>勝率</td><td>獲利筆數 ÷ 已結清總筆數</td></tr>
        <tr><td>均報酬</td><td>每筆已結清交易的平均漲跌幅（含輸贏）</td></tr>
        <tr><td>獲利因子</td><td>總獲利 ÷ 總虧損。&gt; 1 代表策略整體盈利；數字越高越佳</td></tr>
        <tr><td>最大回落</td><td>資金曲線從最高峰到最低谷的最大跌幅（衡量風險）</td></tr>
        <tr><td>期望值</td><td>每次交易的理論均損益 = 勝率×均勝 + 敗率×均敗。正數代表長期有利</td></tr>
        <tr><td>最佳 / 最差</td><td>單筆最高獲利 / 最大虧損，含均勝與均敗</td></tr>
        <tr><td>累積資金曲線</td><td>以複利方式串連每筆交易，視覺化資金成長軌跡</td></tr>
        <tr><td>信心分組表</td><td>4因子高／中／低信心訊號各自的勝率與均報酬，驗證信心分層是否有效</td></tr>
        <tr><td>持倉中</td><td>最後一次黃金交叉尚未出場，顯示當前未實現損益與信心等級</td></tr>
      </table>

      <p><strong>如何解讀：</strong></p>
      <ul>
        <li>獲利因子 &gt; 1.5 且期望值為正 → 策略長期有利</li>
        <li>最大回落 &gt; 20% → 需評估個人承受能力</li>
        <li>高信心訊號勝率明顯高於低信心 → 4因子篩選有效，可優先執行高信心訊號</li>
        <li>資金曲線穩定向右上 → 策略穩定，非靠少數大單撐起</li>
      </ul>

      <p style="color:var(--muted);font-size:0.85rem">回測為事後統計，不代表未來績效。實際交易須自行考量手續費、滑價與個人風險承受度。</p>
    `,
  },
  {
    title: "提醒",
    content: `
      <ul>
        <li><strong>提醒清單</strong>：未來的提醒事項，今天到期以黃色標示</li>
        <li><strong>提醒歷史</strong>：過去觸發的訊號紀錄，含 5 / 10 / 20 天後的報酬表現</li>
      </ul>
      <p>點擊右上角 <strong>＋ 新增</strong> → 輸入標的代碼、日期、備註內容。</p>
      <p style="color:var(--muted);font-size:0.85rem">「結果計算中」表示訊號剛發生，數據尚在收集。</p>
    `,
  },
  {
    title: "交易紀錄",
    content: `
      <h4>新增交易</h4>
      <p>從圖表頁點 <strong>＋ 記錄交易</strong>（建議），或在交易頁直接新增。填入進場日期、價格、方向（做多/做空）。</p>
      <h4>結清交易</h4>
      <p>點擊持倉中的交易 → 填入出場日期與出場價格 → 系統自動計算損益 %。</p>
      <h4>P&amp;L 計算</h4>
      <ul>
        <li><strong>做多</strong>：(出場價 − 進場價) ÷ 進場價 × 100%</li>
        <li><strong>做空</strong>：(進場價 − 出場價) ÷ 進場價 × 100%</li>
      </ul>
    `,
  },
  {
    title: "歷史統計",
    content: `
      <h4>交易統計卡</h4>
      <p>彙整所有已結清交易，按訊號類型分組（黃金交叉、死亡交叉、手動記錄）。</p>
      <table>
        <tr><th>指標</th><th>說明</th></tr>
        <tr><td>勝率</td><td>獲利筆數 ÷ 已結清總筆數</td></tr>
        <tr><td>平均報酬</td><td>每筆已結清交易的平均報酬率</td></tr>
        <tr><td>最大獲利</td><td>單筆最高獲利</td></tr>
        <tr><td>最大虧損</td><td>單筆最大虧損（負數）</td></tr>
      </table>
      <h4>訊號績效追蹤</h4>
      <p>頁面下方自動計算每個標的，在訊號觸發後 <strong>5 日 / 10 日 / 20 日</strong> 的歷史勝率與平均報酬，由系統每日自動更新。</p>
    `,
  },
  {
    title: "通知設定",
    content: `
      <p>觸發條件（可在各標的設定中個別開關）：</p>
      <ul>
        <li><strong>黃金交叉</strong>：MA 快線向上穿越慢線</li>
        <li><strong>死亡交叉</strong>：MA 快線向下穿越慢線</li>
        <li><strong>接近快線</strong>：價格進入 MA 快線 ±1.5% 區間</li>
        <li><strong>離開進場區</strong>：接近後又移動超過 3%，提醒進場窗口已關閉</li>
      </ul>
      <p>每日掃描時間：台股收盤後自動執行（約 16:00–16:30 台灣時間）。</p>
      <h4>通知格式（交叉訊號）</h4>
      <pre>🟢 台積電 黃金交叉 高信心度
MA25 1050.00 ↑ MA60 980.00 · 收盤 1065
RSI 58.3 · MACD柱 +12.45
進場區 1039–1061，跌破 980.00 停損
[AI 操作摘要]</pre>
      <p>AI 摘要為一句直接的操作判斷，說明此訊號的實際意義（如「均線剛確立多排，成交量放大，進場區尚在有效範圍內」）。</p>
      <p style="color:var(--muted);font-size:0.85rem">加密貨幣限定：附帶恐懼貪婪指數情緒行（極度恐慌=反向買入訊號，極度貪婪=分配警示）。</p>
      <h4>早安摘要</h4>
      <p>每日 08:00 台灣時間，系統對自選清單中有活躍訊號（黃金交叉或死亡交叉）的標的進行 AI 簡報，包含當前操作方向與是否接近好的進出場時機。若所有標的均無訊號，則發送一則「今天全部平靜」的提示。</p>
    `,
  },
  {
    title: "自訂均線組合",
    content: `
      <p>預設使用 MA25/MA60，但任何均線組合都支援。</p>
      <table>
        <tr><th>組合</th><th>適用場景</th></tr>
        <tr><td><strong>5/20</strong></td><td>短線波段、加密貨幣、ETF</td></tr>
        <tr><td><strong>25/60</strong></td><td>台股中線操作（預設）</td></tr>
        <tr><td><strong>50/200</strong></td><td>長線趨勢、美股藍籌</td></tr>
      </table>
      <p>修改方式：自選清單 → ⚙ → 點選預設組合或輸入自訂數值 → 儲存。</p>
      <p>儲存後，掃描、圖表、回測、通知全部使用新的均線組合。從自選清單點入圖表時，均線設定自動帶入，圖表與回測完全對應你設定的組合。</p>
    `,
  },
  {
    title: "常見問題",
    content: `
      <dl>
        <dt>為什麼沒收到通知？</dt>
        <dd>確認 ⚙ 設定中「啟用通知」已打開，且 LINE / Telegram 帳號已正確綁定。</dd>

        <dt>加密貨幣跟台股的資料來源不同嗎？</dt>
        <dd>是。台股使用 Yahoo Finance，加密貨幣使用 Kraken。加密貨幣全年無休，台股有交易日限制。</dd>

        <dt>為什麼 MA200 標的有時沒有訊號？</dt>
        <dd>MA200 需要約 320 個日曆天的歷史資料。新上市或資料不足的標的會暫時跳過。</dd>

        <dt>RSI 和 MACD 需要懂嗎？</dt>
        <dd>不需要深入理解，系統已納入信心度評分。通知訊息中的「RSI · MACD柱」一行可快速判斷動能狀況。</dd>

        <dt>AI 分析說「分析有分歧」是什麼意思？</dt>
        <dd>系統同時詢問多個 AI 模型，當不同模型對趨勢方向有不同判斷時會主動標示，提醒你訊號可能處於不確定狀態。</dd>

        <dt>AI 分析中的歷史勝率是哪裡來的？</dt>
        <dd>系統每日自動追蹤每次訊號發生後 5 / 10 / 20 個交易日的實際收盤報酬，長期累積成這個標的的真實勝率統計。資料筆數越多，參考價值越高；新標的或訊號稀少的標的初期可能無歷史資料。</dd>

        <dt>AI 分析顯示「10天前」是什麼意思？</dt>
        <dd>這是訊號年齡，表示黃金交叉或死亡交叉發生至今的天數。訊號越新代表進場窗口越有效；若超過 10–15 天，均線可能已大幅位移，進場條件需重新評估。</dd>

        <dt>早安摘要是什麼？我能關掉嗎？</dt>
        <dd>每天早上 8 點台灣時間自動發送，針對自選清單中有活躍訊號的標的做一句 AI 簡報。目前版本無法個別關閉，若不想收到，可在各標的設定中暫停通知。</dd>

        <dt>回測結果可以直接照做嗎？</dt>
        <dd>回測是事後統計，用於了解策略歷史特性，不是預測。實際交易還需考量滑點、手續費與個人風險承受度。</dd>

        <dt>可以同時追蹤台股和加密貨幣嗎？</dt>
        <dd>可以。自選清單支援混合標的，每個標的獨立設定均線組合與通知條件。</dd>
      </dl>
    `,
  },
];

export function renderHelp(container) {
  container.innerHTML = `
    <h2>使用說明</h2>
    <div id="help-accordion"></div>
  `;

  const accordion = container.querySelector("#help-accordion");

  SECTIONS.forEach((sec, i) => {
    const item = document.createElement("div");
    item.className = "help-item";
    item.style.cssText = "border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden";

    const header = document.createElement("button");
    header.className = "help-header";
    header.style.cssText = [
      "width:100%", "display:flex", "align-items:center", "justify-content:space-between",
      "padding:14px", "background:var(--surface)", "border:none", "color:var(--text)",
      "font-size:0.95rem", "font-weight:600", "cursor:pointer", "text-align:left",
      "-webkit-tap-highlight-color:transparent",
    ].join(";");

    const chevron = document.createElement("span");
    chevron.style.cssText = "flex-shrink:0;transition:transform .2s;font-size:0.8rem;color:var(--muted)";
    chevron.textContent = "▶";

    header.appendChild(document.createTextNode(sec.title));
    header.appendChild(chevron);

    const body = document.createElement("div");
    body.className = "help-body";
    body.style.cssText = "display:none;padding:0 14px 14px;background:var(--surface)";
    body.innerHTML = sec.content;

    header.addEventListener("click", () => {
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      chevron.style.transform = open ? "" : "rotate(90deg)";
    });

    // Open first section by default
    if (i === 0) {
      body.style.display = "block";
      chevron.style.transform = "rotate(90deg)";
    }

    item.appendChild(header);
    item.appendChild(body);
    accordion.appendChild(item);
  });

  injectHelpStyles();
}

function injectHelpStyles() {
  if (document.getElementById("help-styles")) return;
  const style = document.createElement("style");
  style.id = "help-styles";
  style.textContent = `
    .help-body p  { margin-bottom: 10px; line-height: 1.6; font-size: 0.9rem; }
    .help-body h4 { font-size: 0.9rem; font-weight: 700; margin: 12px 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .help-body ul, .help-body ol { padding-left: 18px; margin-bottom: 10px; }
    .help-body li { font-size: 0.9rem; margin-bottom: 4px; line-height: 1.5; }
    .help-body table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 10px; }
    .help-body th { background: var(--bg); color: var(--muted); font-weight: 600; padding: 7px 8px; text-align: left; border-bottom: 1px solid var(--border); }
    .help-body td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; line-height: 1.4; }
    .help-body tr:last-child td { border-bottom: none; }
    .help-body pre { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; font-size: 0.8rem; white-space: pre-wrap; line-height: 1.6; margin-bottom: 10px; font-family: monospace; }
    .help-body dl dt { font-weight: 700; font-size: 0.9rem; margin-top: 12px; margin-bottom: 2px; }
    .help-body dl dt:first-child { margin-top: 0; }
    .help-body dl dd { font-size: 0.88rem; color: var(--muted); margin-left: 0; line-height: 1.5; }
  `;
  document.head.appendChild(style);
}
