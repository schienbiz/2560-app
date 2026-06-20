# cf-worker — 2560 固定前端（Cloudflare Worker）

2560 的**固定 webhook 入口**。所有對外連結（LINE webhook / LIFF / Telegram / GitHub Actions `APP_URL`）都指向這個 Worker，由它透明反向代理到目前 active 的 Render 後端。切換後端只改 Worker 的 `BACKEND` 變數，webhook 永遠不用動。

- **線上網址**：`https://two560-app.atungc2020.workers.dev`
- **現役後端**：`two560-app-2.onrender.com`（atungc2020 Render，免費）
- **交替後端**：`two560-app.onrender.com`（schienbiz，7/1 後當休眠交替後端）
- **CF 帳號**：Atungc2020@gmail.com

## 為什麼這樣設計
- 兩個 Render 帳號的服務當**可互換後端**，前端固定在 CF edge（無單點、免網域）。
- 透明代理保留 raw body（LINE `x-line-signature` HMAC 仍驗得過）、WebSocket 直通。
- 上游 Host 由目標 URL 決定（CF 不允許偽造 Host）→ Render 正確路由。

## `/__up` edge-only 健康檢查（重要）
監控**只能打 `/__up`**：它直接從 Worker 邊緣回 200、**不 fetch 後端** → 高頻 ping 也**不會喚醒(keepalive)睡著的 Render 後端**，避免「監控變 keepalive 燒爆免費池」。後端是否被停權由 AI-PM 的 Render API 狀態監控覆蓋。**絕不要拿會穿透後端的 `/health` 去做排程監控。**

## 部署
```bash
cd cf-worker
npx wrangler login      # 第一次
npx wrangler deploy
```
或 CF dashboard → Workers & Pages → two560-app → Edit code 貼上 `worker.js`，Settings → Variables 設 `BACKEND`。

## 切換後端
改 `wrangler.toml` 的 `BACKEND` 後 `npx wrangler deploy`；或 dashboard → Settings → Variables 改 `BACKEND`（秒級、自動重佈）。
