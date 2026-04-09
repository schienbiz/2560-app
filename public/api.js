/**
 * api.js — fetch wrapper that attaches Authorization header
 *
 * Usage:
 *   import { api } from './api.js';
 *   const data = await api.get('/api/watchlist');
 *   await api.post('/api/watchlist', { symbol: 'BTCUSDT' });
 */

import { getSession } from "./platform.js";

function authHeader() {
  const s = getSession();
  if (!s) throw new Error("Platform not initialized");
  // LINE uses Bearer {id_token}; Telegram uses TG {initData}; dev uses Bearer dev
  const auth = s.platform === "telegram"
    ? `TG ${s.token}`
    : `Bearer ${s.token}`;
  return { Authorization: auth };
}

async function request(method, path, body) {
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }
  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const api = {
  get:    (path)       => request("GET",    path),
  post:   (path, body) => request("POST",   path, body),
  put:    (path, body) => request("PUT",    path, body),
  patch:  (path, body) => request("PATCH",  path, body),
  delete: (path)       => request("DELETE", path),
};
