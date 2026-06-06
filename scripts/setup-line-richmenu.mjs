/**
 * 一次性腳本：建立 LINE Rich Menu（底部 6 格選單）
 *
 * 使用方式：
 *   LINE_CHANNEL_ACCESS_TOKEN=xxx node scripts/setup-line-richmenu.mjs ./richmenu.png
 *
 * 圖片規格（Canva 用）：
 *   尺寸：2500 × 1686 px
 *   版面：2 列 × 3 欄，每格 833×843 px（最後一欄 834px）
 *   格線建議：暗色底，每格有 icon + 中文標籤
 *
 *   格子內容（左→右，上→下）：
 *   [1] 📊 開啟 App     [2] 📈 今日訊號   [3] 🤖 問 AI
 *   [4] 📋 自選清單     [5] 💹 交易記錄   [6] ❓ 使用說明
 */

import fs from "fs"
import path from "path"

const TOKEN   = process.env.LINE_CHANNEL_ACCESS_TOKEN
const imgPath = process.argv[2]

if (!TOKEN)   { console.error("❌ 請設定 LINE_CHANNEL_ACCESS_TOKEN"); process.exit(1) }
if (!imgPath) { console.error("❌ 請提供圖片路徑，例如 ./richmenu.png"); process.exit(1) }
if (!fs.existsSync(imgPath)) { console.error(`❌ 找不到圖片：${imgPath}`); process.exit(1) }

const BASE = "https://api.line.me/v2/bot"
const headers = { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" }

const LIFF_URL = "https://miniapp.line.me/2009750300-3ibNysMP"

// ─── 1. 建立 Rich Menu 定義 ───────────────────────────────────────────────────
const menuDef = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: "2560戰法選單",
  chatBarText: "選單",
  areas: [
    // Row 1
    { bounds: { x: 0,    y: 0, width: 833,  height: 843 }, action: { type: "uri",     uri: LIFF_URL,      label: "開啟App" } },
    { bounds: { x: 833,  y: 0, width: 833,  height: 843 }, action: { type: "message", text: "今日訊號",   label: "今日訊號" } },
    { bounds: { x: 1666, y: 0, width: 834,  height: 843 }, action: { type: "message", text: "AI分析",     label: "問AI" } },
    // Row 2
    { bounds: { x: 0,    y: 843, width: 833,  height: 843 }, action: { type: "message", text: "我的自選清單", label: "自選清單" } },
    { bounds: { x: 833,  y: 843, width: 833,  height: 843 }, action: { type: "message", text: "交易記錄",   label: "交易記錄" } },
    { bounds: { x: 1666, y: 843, width: 834,  height: 843 }, action: { type: "message", text: "怎麼使用？", label: "使用說明" } },
  ],
}

console.log("1️⃣  建立 Rich Menu 定義…")
const createRes = await fetch(`${BASE}/richmenu`, {
  method: "POST",
  headers,
  body: JSON.stringify(menuDef),
})
const { richMenuId } = await createRes.json()
if (!richMenuId) { console.error("❌ 建立失敗", await createRes.text()); process.exit(1) }
console.log(`   richMenuId: ${richMenuId}`)

// ─── 2. 上傳背景圖 ────────────────────────────────────────────────────────────
console.log("2️⃣  上傳圖片…")
const ext = path.extname(imgPath).toLowerCase()
const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png"
const imgData = fs.readFileSync(imgPath)

const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": mime },
  body: imgData,
})
if (!uploadRes.ok) { console.error("❌ 上傳失敗", await uploadRes.text()); process.exit(1) }
console.log("   圖片上傳成功")

// ─── 3. 設為預設 Rich Menu ────────────────────────────────────────────────────
console.log("3️⃣  設為預設選單…")
const setRes = await fetch(`${BASE}/user/all/richmenu/${richMenuId}`, {
  method: "POST",
  headers,
})
if (!setRes.ok) { console.error("❌ 設定預設失敗", await setRes.text()); process.exit(1) }

console.log(`\n✅ Rich Menu 設定完成！richMenuId: ${richMenuId}`)
console.log("   所有用戶打開聊天室就會看到底部選單。")
console.log(`\n   若要刪除：`)
console.log(`   curl -X DELETE https://api.line.me/v2/bot/richmenu/${richMenuId} -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN"`)
