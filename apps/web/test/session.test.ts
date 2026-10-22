import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Session } from "../src/lib/session.ts";

/** A scripted server: each path answers from a queue (or a fixed reply), and every call is recorded. */
function server(routes: Record<string, (() => Response) | Response[]>) {
  const calls: { path: string; auth: string | null }[] = [];
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const path = String(input);
    calls.push({ path, auth: new Headers(init.headers).get("authorization") });
    const route = routes[path];
    if (!route) return new Response("{}", { status: 404 });
    const reply = Array.isArray(route) ? route.shift() : route();
    return reply ?? new Response("{}", { status: 500 });
  };
  return { fetch, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tokens = (n: number, expiresIn = 3600) => json({ accessToken: `token-${n}`, expiresIn, user: { email: "a@example.com", admin: false } });
const health = (signIn: string) => () => json({ signIn });

describe("Session", () => {
  it("everyone is a guest when the server has no user pool", async () => {
    const s = new Session({ ...server({ "/api/health": health("off") }), dev: false });
    await s.init();
    assert.deepEqual(s.state, { status: "guest", user: null, available: false, expired: false });
  });

  it("restores a session from the refresh cookie on load", async () => {
    const s = new Session({ ...server({ "/api/health": health("email-otp"), "/api/auth/refresh": [tokens(1)] }), dev: false });
    await s.init();
    assert.equal(s.state.status, "signed-in");
    assert.deepEqual(await s.headers(), { Authorization: "Bearer token-1" });
  });

  it("starts as a guest without a cookie, and that isn't 'your session ended'", async () => {
    const s = new Session({ ...server({ "/api/health": health("email-otp"), "/api/auth/refresh": [json({}, 401)] }), dev: false });
    await s.init();
    assert.equal(s.state.status, "guest");
    assert.equal(s.state.expired, false);
  });

  it("signs in from a verified code, and passes on the server's error messages", async () => {
    const routes = {
      "/api/health": health("email-otp"),
      "/api/auth/refresh": [json({}, 401)],
      "/api/auth/start": [json({ ok: true, next: "code" })],
      "/api/auth/verify": [json({ error: "That code isn't right." }, 400), tokens(1)],
    };
    const s = new Session({ ...server(routes), dev: false });
    await s.init();
    assert.deepEqual(await s.start("a@example.com", "signin"), { ok: true, signedIn: false });
    assert.deepEqual(await s.verify("000000"), { ok: false, error: "That code isn't right.", restart: undefined });
    assert.deepEqual(await s.verify("123456"), { ok: true, signedIn: true });
    assert.equal(s.state.user?.email, "a@example.com");
  });

  it("renews a token that's about to expire, once, even for parallel requests", async () => {
    let now = 0;
    const api = server({ "/api/health": health("email-otp"), "/api/auth/refresh": [tokens(1, 120), tokens(2)], "/api/me/stories": () => json({}) });
    const s = new Session({ ...api, now: () => now, dev: false });
    await s.init();
    now = 70_000; // 50 s left: inside the one-minute margin
    await Promise.all([s.fetch("/api/me/stories"), s.fetch("/api/me/stories")]);
    assert.equal(api.calls.filter((c) => c.path === "/api/auth/refresh").length, 2, "load + one renewal");
    assert.deepEqual(api.calls.filter((c) => c.path === "/api/me/stories").map((c) => c.auth), ["Bearer token-2", "Bearer token-2"]);
  });

  it("retries once after a 401 with a renewed token", async () => {
    const api = server({
      "/api/health": health("email-otp"),
      "/api/auth/refresh": [tokens(1), tokens(2)],
      "/api/me/stories": [json({}, 401), json({ stories: [] })],
    });
    const s = new Session({ ...api, dev: false });
    await s.init();
    assert.equal((await s.fetch("/api/me/stories")).status, 200);
    assert.deepEqual(api.calls.filter((c) => c.path === "/api/me/stories").map((c) => c.auth), ["Bearer token-1", "Bearer token-2"]);
  });

  it("becomes a guest with a 'session ended' notice when renewal is refused", async () => {
    const api = server({
      "/api/health": health("email-otp"),
      "/api/auth/refresh": [tokens(1), json({ signedIn: false, expired: true }, 401)],
      "/api/me/stories": [json({}, 401)],
    });
    const s = new Session({ ...api, dev: false });
    await s.init();
    assert.equal((await s.fetch("/api/me/stories")).status, 401);
    assert.equal(s.state.status, "guest");
    assert.equal(s.state.expired, true);
    assert.deepEqual(await s.headers(), {}, "no stale token is sent again");
    s.dismissExpired();
    assert.equal(s.state.expired, false);
  });

  it("signs out even when the network fails", async () => {
    const api = server({ "/api/health": health("email-otp"), "/api/auth/refresh": [tokens(1)] });
    const s = new Session({
      fetch: (input, init) => (String(input) === "/api/auth/signout" ? Promise.reject(new Error("offline")) : api.fetch(input, init)),
      dev: false,
    });
    await s.init();
    await s.signOut();
    assert.equal(s.state.status, "guest");
    assert.deepEqual(await s.headers(), {});
  });
});
