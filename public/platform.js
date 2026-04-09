/**
 * platform.js — LINE LIFF + Telegram WebApp initialization
 *
 * Returns: { userId, platform, token }
 * platform: "line" | "telegram" | "dev"
 * token: passed as Authorization header to the API
 */

let _session = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function showDebug(msg) {
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;top:0;left:0;right:0;background:red;color:#fff;font-size:12px;padding:6px;z-index:9999;word-break:break-all";
  el.textContent = msg;
  document.body.appendChild(el);
}

export async function initPlatform() {
  if (_session) return _session;

  showDebug(`TG=${!!window.Telegram} | TG.WA=${!!window.Telegram?.WebApp} | liff=${typeof liff} | LIFF_ID=${!!window.__LIFF_ID__}`);

  // ── Telegram ──────────────────────────────────────────────────
  // Check for WebApp object existence, not initData (which can be empty string on first load)
  if (window.Telegram?.WebApp !== undefined) {
    const tg = window.Telegram.WebApp;
    tg.expand();
    tg.ready();

    const user = tg.initDataUnsafe?.user;
    _session = {
      platform: "telegram",
      userId: String(user?.id ?? "unknown"),
      token: tg.initData,          // raw initData, verified server-side with HMAC
    };
    return _session;
  }

  // ── LINE LIFF ─────────────────────────────────────────────────
  // Only attempt LIFF when not in Telegram and a LIFF ID is configured.
  // Load the SDK dynamically so it never runs in Telegram WebView.
  const liffId = window.__LIFF_ID__;
  if (liffId && !window.Telegram) {
    try {
      await loadScript("https://static.line-scdn.net/liff/edge/2/sdk.js");
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) {
        liff.login();
        await new Promise(() => {});
      }
      const profile = await liff.getProfile();
      const idToken = liff.getIDToken();
      _session = {
        platform: "line",
        userId: profile.userId,
        token: idToken,
      };
      return _session;
    } catch (e) {
      console.warn("LIFF init failed, falling through to dev mode", e);
    }
  }

  // ── Dev / browser fallback ────────────────────────────────────
  // Lets you run the app locally without LINE/TG context.
  // The server must accept "dev" platform requests (disabled in production).
  _session = {
    platform: "dev",
    userId: "dev-user",
    token: "dev",
  };
  return _session;
}

export function getSession() {
  return _session;
}
