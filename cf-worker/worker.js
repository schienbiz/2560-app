// 2560-app 固定前端反向代理 (Cloudflare Worker)
//
// 所有請求都透明轉送到目前 active 的 Render 後端 (env.BACKEND)。
// 要切換後端：在 Worker dashboard → Settings → Variables 改 BACKEND 一個值即可，
// LINE/Telegram/LIFF/Actions 的 webhook 永遠不用動。
//
// 設計要點 (見極致審視)：
//  - 整個 Request 直通 (method/headers/raw body 不動) → LINE x-line-signature
//    (對 raw body 做 HMAC) 與 Telegram secret_token 都仍能驗證成功。
//  - 上游 Host 由目標 URL 決定 (CF 不允許手動偽造 Host) → Render 能正確路由到服務。
//  - WebSocket 升級 (自選清單即時報價) 透明直通，CF 回傳 101 + webSocket。

export default {
  async fetch(request, env) {
    const backend = env.BACKEND;
    if (!backend) {
      return new Response("BACKEND 變數未設定", { status: 500 });
    }

    const url = new URL(request.url);

    // Edge-only 健康檢查：直接從 Worker 邊緣回 200，【不】fetch 後端。
    // 監控可高頻 ping 這條而【不會喚醒(keepalive)】睡著的 Render 後端 →
    // 避免「監控變 keepalive 燒爆 Render 免費池」(2026-06-19 事故根因)。
    // 後端是否被停權改由 AI-PM 的 Render API 狀態監控覆蓋(不喚醒服務)。
    if (url.pathname === "/__up") {
      return new Response(JSON.stringify({ ok: true, layer: "worker-edge" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const target = new URL(backend);

    // 只換 host，path + query + method + headers + body 全部保留
    url.protocol = target.protocol;
    url.hostname = target.hostname;
    url.port = target.port;

    return fetch(new Request(url, request));
  },
};
