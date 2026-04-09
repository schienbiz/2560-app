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


export async function initPlatform() {
  if (_session) return _session;

  // ── Telegram ──────────────────────────────────────────────────
  // Detect via multiple signals — window.Telegram is not always injected on iOS.
  // Telegram always appends tgWebApp* params to the URL hash when opening a Mini App.
  const hash = location.hash.slice(1);
  const hashParams = new URLSearchParams(hash);
  const tgWebAppData = hashParams.get("tgWebAppData");
  const isTelegram = window.Telegram?.WebApp !== undefined || !!tgWebAppData;

  if (isTelegram) {
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.expand(); tg.ready(); }

    // initData from window.Telegram.WebApp or from URL hash
    const initData = tg?.initData || tgWebAppData || "";
    const user = tg?.initDataUnsafe?.user;
    const userId = user?.id ? String(user.id) : hashParams.get("tgWebAppUserId") ?? "tg-user";

    _session = {
      platform: "telegram",
      userId,
      token: initData,
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
