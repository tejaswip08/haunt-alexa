import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";

// Offline: the mock Cognito stand-in, no AWS calls. Each test drives the TV's poll, the phone's approve and Cognito's refresh.
const { createAuthRouter } = await import("../src/auth-route.ts");
const { createMockAuth } = await import("../src/mock-auth.ts");
const { createRateLimiter } = await import("../src/rate-limit.ts");
const { CognitoError } = await import("../src/cognito-client.ts");

const codes: string[] = [];
const mock = createMockAuth((line) => codes.push(line.split(": ").pop()!));
const app = express();
app.use(express.json());
// Generous limits: every test shares one address, and these tests are about the handoff, not the rate limits.
const roomy = () => createRateLimiter([{ windowMs: 60_000, max: 10_000 }]);
app.use("/api/auth", createAuthRouter({ cognito: mock.cognito, secureCookies: false, adminGroup: "haunt-admins", limits: { perIp: roomy(), perEmail: roomy(), perPoll: roomy() } }));

let base = "";
const server = app.listen(0);
before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** A browser-ish client that keeps its own cookies, like a real device. */
function client() {
  const jar = new Map<string, string>();
  return async (path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "X-Haunt-Client": "web", "Content-Type": "application/json", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
      body: JSON.stringify(body ?? {}),
    });
    for (const line of response.headers.getSetCookie()) {
      const [name = "", value = ""] = (line.split(";")[0] ?? "").split("=");
      if (/Max-Age=0/.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
}

/** Signs a phone in and approves the TV's code, but leaves the TV's poll for the test to make. */
async function approvedPhone(email: string) {
  const tv = client();
  const phone = client();
  const started = await tv("/api/auth/device/start");
  assert.equal((await phone("/api/auth/start", { email, mode: "signup" })).status, 200);
  assert.equal((await phone("/api/auth/verify", { code: codes.at(-1) })).status, 200);
  return { tv, phone, started: started.data };
}

/** Holds Cognito's refresh until released, so a test can run a second request while the first is confirming. */
function holdRefresh() {
  const original = mock.cognito.refresh;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  mock.cognito.refresh = async (...args: Parameters<typeof original>) => {
    await gate;
    return original.apply(mock.cognito, args);
  };
  return { release, restore: () => (mock.cognito.refresh = original) };
}

describe("TV handoff after the phone approves", () => {
  it("answers pending, not expired, to a second poll that arrives while the first is confirming the approval", async () => {
    const { tv, phone, started } = await approvedPhone("handoff-overlap@example.com");
    assert.equal((await phone("/api/auth/device/approve", { userCode: started.userCode })).status, 200);
    const hold = holdRefresh();
    try {
      const first = tv("/api/auth/device/poll", { deviceCode: started.deviceCode });
      const second = await tv("/api/auth/device/poll", { deviceCode: started.deviceCode });
      assert.equal(second.data.status, "pending", "the approval is still being confirmed, so the code has not expired");
      hold.release();
      const approved = await first;
      assert.equal(approved.data.status, "approved");
      assert.equal(approved.data.user.email, "handoff-overlap@example.com");
    } finally {
      hold.release();
      hold.restore();
    }
  });

  it("keeps the approval when Cognito is briefly unavailable during the poll, and the next poll completes the handoff", async () => {
    const { tv, phone, started } = await approvedPhone("handoff-retry@example.com");
    assert.equal((await phone("/api/auth/device/approve", { userCode: started.userCode })).status, 200);
    const original = mock.cognito.refresh;
    let failures = 1;
    mock.cognito.refresh = async (...args: Parameters<typeof original>) => {
      if (failures-- > 0) throw new CognitoError("ThrottlingException", "slow down");
      return original.apply(mock.cognito, args);
    };
    try {
      const interrupted = await tv("/api/auth/device/poll", { deviceCode: started.deviceCode });
      assert.notEqual(interrupted.data.status, "expired", "a transient error is not an expired code");
      assert.notEqual(interrupted.status, 200, "the TV is told the poll didn't complete");
      const retried = await tv("/api/auth/device/poll", { deviceCode: started.deviceCode });
      assert.equal(retried.data.status, "approved", "the approval survives the failed poll");
    } finally {
      mock.cognito.refresh = original;
    }
  });

  it("says expired for a code that ran out before the phone approved it", async () => {
    const { tv, phone, started } = await approvedPhone("handoff-expiry@example.com");
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000;
    try {
      assert.equal((await phone("/api/auth/device/approve", { userCode: started.userCode })).status, 400);
      assert.equal((await tv("/api/auth/device/poll", { deviceCode: started.deviceCode })).data.status, "expired");
    } finally {
      Date.now = realNow;
    }
  });

  it("gives an approved code to one TV only, even when the same TV polls twice", async () => {
    const { tv, phone, started } = await approvedPhone("handoff-once@example.com");
    assert.equal((await phone("/api/auth/device/approve", { userCode: started.userCode })).status, 200);
    const [a, b] = await Promise.all([
      tv("/api/auth/device/poll", { deviceCode: started.deviceCode }),
      tv("/api/auth/device/poll", { deviceCode: started.deviceCode }),
    ]);
    const approvals = [a, b].filter((answer) => answer.data.status === "approved");
    assert.equal(approvals.length, 1, "one session is handed over");
    assert.equal((await tv("/api/auth/device/poll", { deviceCode: started.deviceCode })).data.status, "expired");
  });

  it("keeps two TVs' handoffs apart: approving one TV's code never completes another TV's poll", async () => {
    const first = await approvedPhone("handoff-tv-a@example.com");
    const second = await approvedPhone("handoff-tv-b@example.com");
    assert.equal((await first.phone("/api/auth/device/approve", { userCode: first.started.userCode })).status, 200);
    assert.equal((await second.tv("/api/auth/device/poll", { deviceCode: second.started.deviceCode })).data.status, "pending");
    const done = await first.tv("/api/auth/device/poll", { deviceCode: first.started.deviceCode });
    assert.equal(done.data.user.email, "handoff-tv-a@example.com");
  });
});

