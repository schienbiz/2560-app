/**
 * Front Worker failover. The rule it must hold: fail over only when the primary
 * certainly did NOT process the request, or a webhook/scan could run twice.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
// @ts-expect-error — plain JS module deployed by wrangler
import worker from "../cf-worker/worker.js"

const ENV = { BACKEND: "https://primary.example", BACKEND_STANDBY: "https://standby.example" }
const hits: { host: string; method: string; body: string }[] = []

function stubFetch(primary: "ok" | "suspended" | "no-server" | "down" | "503-plain") {
  vi.stubGlobal("fetch", async (req: Request) => {
    const host = new URL(req.url).hostname
    hits.push({ host, method: req.method, body: req.body ? await req.text() : "" })
    if (host === "primary.example") {
      if (primary === "down") throw new TypeError("network connection lost")
      if (primary === "suspended") return new Response("suspended", { status: 503, headers: { "x-render-routing": "suspend" } })
      if (primary === "no-server") return new Response("not found", { status: 404, headers: { "x-render-routing": "no-server" } })
      if (primary === "503-plain") return new Response("busy", { status: 503 })
    }
    return new Response(`from ${host}`, { status: 200 })
  })
}

const get  = () => new Request("https://two560.workers.dev/health")
const post = () => new Request("https://two560.workers.dev/webhook/telegram", { method: "POST", body: '{"update_id":1}' })

afterEach(() => { vi.unstubAllGlobals(); hits.length = 0 })

describe("cf-worker failover", () => {
  it("serves from the primary when it answers", async () => {
    stubFetch("ok")
    const res = await worker.fetch(post(), ENV)
    expect(await res.text()).toBe("from primary.example")
    expect(res.headers.get("x-2560-backend")).toBe("primary")
    expect(hits.map(h => h.host)).toEqual(["primary.example"])
  })

  it("a Render-suspended primary fails over for ANY method, body intact", async () => {
    stubFetch("suspended")
    const res = await worker.fetch(post(), ENV)
    expect(await res.text()).toBe("from standby.example")
    expect(res.headers.get("x-2560-backend")).toBe("standby")
    expect(hits[1]).toEqual({ host: "standby.example", method: "POST", body: '{"update_id":1}' })
  })

  it("any routing-layer answer fails over (no-server, seen live 2026-10-14)", async () => {
    stubFetch("no-server")
    const res = await worker.fetch(post(), ENV)
    expect(await res.text()).toBe("from standby.example")
  })

  it("an unreachable primary fails over a GET", async () => {
    stubFetch("down")
    const res = await worker.fetch(get(), ENV)
    expect(await res.text()).toBe("from standby.example")
  })

  it("an unreachable primary does NOT replay a POST (it may have been processed)", async () => {
    stubFetch("down")
    await expect(worker.fetch(post(), ENV)).rejects.toThrow()
    expect(hits.map(h => h.host)).toEqual(["primary.example"])
  })

  it("a plain 503 from the app is returned, not failed over", async () => {
    stubFetch("503-plain")
    const res = await worker.fetch(post(), ENV)
    expect(res.status).toBe(503)
    expect(hits).toHaveLength(1)
  })

  it("without BACKEND_STANDBY it behaves exactly as before", async () => {
    stubFetch("suspended")
    const res = await worker.fetch(post(), { BACKEND: ENV.BACKEND })
    expect(res.status).toBe(503)
    expect(hits).toHaveLength(1)
  })

  it("/__up answers at the edge without touching any backend", async () => {
    stubFetch("ok")
    const res = await worker.fetch(new Request("https://two560.workers.dev/__up"), ENV)
    expect(await res.json()).toEqual({ ok: true, layer: "worker-edge" })
    expect(hits).toHaveLength(0)
  })
})
