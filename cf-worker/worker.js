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
//
// 自動備援 (env.BACKEND_STANDBY，2026-10-14)：
//  兩個後端共用同一顆 Neon，但過去切換要靠人發現 + 手改 BACKEND。2026-06-19
//  schienbiz 因免費池耗盡被 Render 停權 12 天，那段期間 bot/LIFF/排程全掛。
//  現在只在「主後端確定沒處理到這個請求」時自動改打備援：
//   1. 主後端的錯誤回應帶 `x-render-routing`（suspend / no-server …）—— 是 Render
//      路由層在進到 app 之前就擋下（app 自己的回應沒有這個 header），任何方法都安全重送。
//   2. 連不上主後端 (fetch 拋錯) —— 只限 GET/HEAD。POST (webhook、scan) 可能
//      已被處理一半，重送會重複推播，所以不做。
//  WebSocket 升級不做備援。回應帶 `x-2560-backend: primary|standby` 方便查證。

/**
 * Did Render's ROUTING layer answer instead of the app? Then the app never saw
 * the request and replaying it elsewhere is safe for any method.
 * Checked live 2026-10-14: an app response carries no `x-render-routing` at all
 * (only `x-render-origin-server`); a missing service answers 404 with
 * `x-render-routing: no-server`; the 2026-06-19 suspension answered 503 with
 * `x-render-routing: suspend`. Any value counts, so an unseen one still fails over.
 */
export function isRenderSuspended(res) {
  return res.status >= 400 && res.headers.has("x-render-routing");
}

function retarget(request, base) {
  const url = new URL(request.url);
  const target = new URL(base);
  // 只換 host，path + query + method + headers + body 全部保留
  url.protocol = target.protocol;
  url.hostname = target.hostname;
  url.port = target.port;
  return new Request(url, request);
}

function tag(res, which) {
  // 101 (WebSocket) responses cannot be re-wrapped; pass them through untouched.
  if (res.status === 101) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-2560-backend", which);
  return out;
}

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

    const standby = env.BACKEND_STANDBY;
    const isUpgrade = (request.headers.get("upgrade") || "").toLowerCase() === "websocket";
    if (!standby || isUpgrade) {
      return fetch(retarget(request, backend));
    }

    // Keep a replayable copy: a Request body can be read only once.
    const replay = request.clone();
    const idempotent = request.method === "GET" || request.method === "HEAD";

    let res;
    try {
      res = await fetch(retarget(request, backend));
    } catch (err) {
      if (!idempotent) throw err;
      return tag(await fetch(retarget(replay, standby)), "standby");
    }
    if (isRenderSuspended(res)) {
      return tag(await fetch(retarget(replay, standby)), "standby");
    }
    return tag(res, "primary");
  },
};
