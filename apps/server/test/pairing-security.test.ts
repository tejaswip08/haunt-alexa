import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";

// Offline: the mock Cognito stand-in, no AWS calls. These tests cover the TV pairing rules:
// explicit approval, cancellation, single use, and that the TV never receives the phone's tokens.
const { createAuthRouter } = await import("../src/auth-route.ts");
const { createMockAuth } = await import("../src/mock-auth.ts");
const { createRateLimiter } = await import("../src/rate-limit.ts");

// Generous limits: these tests make many calls from one address. Limits have their own tests.
const roomy = () => createRateLimiter([{ windowMs: 60_000, max: 10_000 }]);

const codes: string[] = [];
const mock = createMockAuth((line) => codes.push(line.split(": ").pop()!));

const app = express();
app.use(express.json());
app.use(
  "/api/auth",
  createAuthRouter({
    cognito: mock.cognito,
    secureCookies: false,
    adminGroup: "haunt-admins",
    limits: { perIp: roomy(), perEmail: roomy(), perPoll: roomy() },
  }),
);

let base = "";
const server = app.listen(0);
before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** A browser-ish client with its own cookie jar. */
function client() {
  const jar = new Map<string, string>();
  const send = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "X-Haunt-Client": "web",
        "Content-Type": "application/json",
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [name = "", value = ""] = (line.split(";")[0] ?? "").split("=");
      if (/Max-Age=0/.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
  return { send, jar };
}

/** A phone signed in as a new account (the mock logs its code, which we read back). */
async function signedInPhone(email: string) {
  const phone = client();
  await phone.send("/api/auth/start", { email, mode: "signup" });
  const verified = await phone.send("/api/auth/verify", { code: codes.at(-1) });
  assert.equal(verified.status, 200);
  return phone;
}

async function startTv() {
  const tv = client();
  const started = await tv.send("/api/auth/device/start");
  return { tv, ...started.data } as { tv: ReturnType<typeof client>; deviceCode: string; userCode: string };
}

describe("TV pairing: explicit approval and cancellation", () => {
  it("stays pending until the phone explicitly approves", async () => {
    const { tv, deviceCode } = await startTv();
    await signedInPhone("pending@example.com");
    assert.equal((await tv.send("/api/auth/device/poll", { deviceCode })).data.status, "pending");
    assert.equal((await tv.send("/api/auth/device/poll", { deviceCode })).data.status, "pending");
  });

  it("gives the TV its own session, and never returns the phone's refresh token", async () => {
    const { tv, deviceCode, userCode } = await startTv();
    const phone = await signedInPhone("tv-owner@example.com");
    const phoneCookie = phone.jar.get("haunt_session");

    assert.equal((await phone.send("/api/auth/device/approve", { userCode })).status, 200);
    const polled = await tv.send("/api/auth/device/poll", { deviceCode });
    assert.equal(polled.data.status, "approved");
    assert.equal(polled.data.user.email, "tv-owner@example.com");
    assert.ok(!("refreshToken" in polled.data), "no refresh token in the response");
    assert.ok(!JSON.stringify(polled.data).includes(phoneCookie!), "the phone's session id is not sent to the TV");

    // The TV's cookie is its own opaque session, distinct from the phone's.
    const tvCookie = tv.jar.get("haunt_session");
    assert.ok(tvCookie && tvCookie !== phoneCookie, "the TV has a session of its own");
    assert.equal((await tv.send("/api/auth/refresh")).status, 200);
    assert.equal((await phone.send("/api/auth/refresh")).status, 200);
  });

  it("ends the TV's session when the phone signs out", async () => {
    const { tv, deviceCode, userCode } = await startTv();
    const phone = await signedInPhone("signout@example.com");
    await phone.send("/api/auth/device/approve", { userCode });
    await tv.send("/api/auth/device/poll", { deviceCode });
    assert.equal((await tv.send("/api/auth/refresh")).status, 200);

    assert.equal((await phone.send("/api/auth/signout")).status, 200);
    assert.equal((await tv.send("/api/auth/refresh")).status, 401, "the TV's session ends with the phone's");
  });

  it("is single use: the code can't be approved or polled into a second session", async () => {
    const { tv, deviceCode, userCode } = await startTv();
    const phone = await signedInPhone("single-use@example.com");
    assert.equal((await phone.send("/api/auth/device/approve", { userCode })).status, 200);
    assert.equal((await tv.send("/api/auth/device/poll", { deviceCode })).data.status, "approved");
    assert.equal((await tv.send("/api/auth/device/poll", { deviceCode })).data.status, "expired");
    assert.equal((await phone.send("/api/auth/device/approve", { userCode })).status, 400);
  });

  it("the TV can cancel: the phone's approval is then refused, and the TV learns it was cancelled", async () => {
    const { tv, deviceCode, userCode } = await startTv();
    const phone = await signedInPhone("tv-cancel@example.com");
    assert.equal((await tv.send("/api/auth/device/cancel", { deviceCode })).status, 200);
    assert.equal((await phone.send("/api/auth/device/approve", { userCode })).status, 400);
    assert.equal((await tv.send("/api/auth/device/poll", { deviceCode })).data.status, "cancelled");
    assert.equal((await tv.send("/api/auth/refresh")).status, 401, "no session for a cancelled pairing");
  });

  it("the phone can decline: the TV's code is void", async () => {
    const { tv, deviceCode, userCode } = await startTv();
    const phone = await signedInPhone("decline@example.com");
    assert.equal((await phone.send("/api/auth/device/decline", { userCode })).status, 200);
    assert.equal((await phone.send("/api/auth/device/approve", { userCode })).status, 400);
    assert.equal((await tv.send("/api/auth/device/poll", { deviceCode })).data.status, "cancelled");
  });

  it("refuses approval from a phone that isn't signed in", async () => {
    const { userCode } = await startTv();
    assert.equal((await client().send("/api/auth/device/approve", { userCode })).status, 401);
  });

  it("never reuses a user code for a second TV while the first is pending", async () => {
    const first = await startTv();
    const second = await startTv();
    assert.notEqual(first.userCode, second.userCode);
    assert.notEqual(first.deviceCode, second.deviceCode);
  });
});
