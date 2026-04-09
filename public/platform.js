/**
 * platform.js — LINE LIFF + Telegram WebApp initialization
 *
 * Returns: { userId, platform, token }
 * platform: "line" | "telegram" | "dev"
 * token: passed as Authorization header to the API
 */

let _session = null;

export async function initPlatform() {
  if (_session) return _session;

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
  // Never run LIFF inside a Telegram WebView (window.Telegram is injected by Telegram)
  const liffId = window.__LIFF_ID__ ?? import.meta.env?.VITE_LIFF_ID;
  if (typeof liff !== "undefined" && liffId && !window.Telegram) {
    try {
      await liff.init({ liffId });
      if (!liff.isLoggedIn()) {
        liff.login();
        // login() redirects, so we block here
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
