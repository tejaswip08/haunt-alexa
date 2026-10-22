import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";

// Offline: the mock Cognito stand-in, no AWS calls.
const { createAuthRouter } = await import("../src/auth-route.ts");
const { createMockAuth } = await import("../src/mock-auth.ts");
const { identify, userOf } = await import("../src/auth.ts");

const codes: string[] = [];
const mock = createMockAuth((line) => codes.push(line.split(": ").pop()!));

const app = express();
app.use(express.json());
app.use("/api/auth", createAuthRouter({ cognito: mock.cognito, secureCookies: false, adminGroup: "haunt-admins" }));
app.get("/api/whoami", identify(mock.authenticate), (_req, res) => res.json({ sub: userOf(res)?.sub ?? null }));

let base = "";
const server = app.listen(0);
before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** A browser-ish client: keeps its own cookies. */
function client() {
  const jar = new Map<string, string>();
  return async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined && path.startsWith("/api/whoami") ? "GET" : "POST",
      headers: {
        "X-Haunt-Client": "web",
        "Content-Type": "application/json",
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [name = "", value = ""] = (line.split(";")[0] ?? "").split("=");
      if (/Max-Age=0/.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    return { status: response.status, data: (await response.json()) as Record<string, any> };
  };
}

describe("TV sign-in with a phone (device flow)", () => {
  it("lets a signed-in phone approve a TV, which then gets its own session", async () => {
    const tv = client();
    const phone = client();

    const started = await tv("/api/auth/device/start", {});
    assert.equal(started.status, 200);
    assert.match(started.data.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.match(started.data.verificationUriComplete, /\/activate#code=/);
    assert.equal((await tv("/api/auth/device/poll", { deviceCode: started.data.deviceCode })).data.status, "pending");

    // Phone: approving before signing in is refused.
    assert.equal((await phone("/api/auth/device/approve", { userCode: started.data.userCode })).status, 401);

    // Phone: create an account with the emailed (here: logged) code.
    assert.equal((await phone("/api/auth/start", { email: "viewer@example.com", mode: "signup" })).status, 200);
    const verified = await phone("/api/auth/verify", { code: codes.at(-1) });
    assert.ok(verified.data.accessToken);
    assert.equal(verified.data.user.email, "viewer@example.com");

    // Codes may be typed without the dash.
    const approved = await phone("/api/auth/device/approve", { userCode: started.data.userCode.replace("-", "").toLowerCase() });
    assert.equal(approved.status, 200);

    const polled = await tv("/api/auth/device/poll", { deviceCode: started.data.deviceCode });
    assert.equal(polled.data.status, "approved");
    assert.equal(polled.data.user.email, "viewer@example.com");

    // The TV's token works on the API, and its refresh cookie renews it.
    const who = await tv("/api/whoami", undefined, { Authorization: `Bearer ${polled.data.accessToken}` });
    assert.ok(who.data.sub);
    assert.ok((await tv("/api/auth/refresh", {})).data.accessToken);

    // A device code can be used only once.
    assert.equal((await tv("/api/auth/device/poll", { deviceCode: started.data.deviceCode })).data.status, "expired");
  });

  it("completes a QR sign-in when the phone's emailed code arrives with a space, and the TV's code is typed in lowercase", async () => {
    const tv = client();
    const phone = client();
    const started = await tv("/api/auth/device/start", {});
    assert.equal((await phone("/api/auth/start", { email: "qr-space@example.com", mode: "signup" })).status, 200);
    const sent = codes.at(-1)!;
    // The phone's code field gets the digits with a space from iOS autofill; the page sends only the digits, and the server accepts both.
    const verified = await phone("/api/auth/verify", { code: `${sent.slice(0, 4)} ${sent.slice(4)}` });
    assert.equal(verified.status, 200, "the autofilled code is accepted");
    assert.equal(verified.data.user.email, "qr-space@example.com");
    const approved = await phone("/api/auth/device/approve", { userCode: started.data.userCode.toLowerCase() });
    assert.equal(approved.status, 200);
    const polled = await tv("/api/auth/device/poll", { deviceCode: started.data.deviceCode });
    assert.equal(polled.data.status, "approved");
    assert.equal(polled.data.user.email, "qr-space@example.com");
  });

  it("refuses a TV code from a different sign-in attempt, so two TVs never share an approval", async () => {
    const tvA = client();
    const tvB = client();
    const phone = client();
    const a = await tvA("/api/auth/device/start", {});
    const b = await tvB("/api/auth/device/start", {});
    assert.notEqual(a.data.userCode, b.data.userCode);
    await phone("/api/auth/start", { email: "two-tvs@example.com", mode: "signup" });
    assert.equal((await phone("/api/auth/verify", { code: codes.at(-1) })).status, 200);
    assert.equal((await phone("/api/auth/device/approve", { userCode: a.data.userCode })).status, 200);
    assert.equal((await tvB("/api/auth/device/poll", { deviceCode: b.data.deviceCode })).data.status, "pending", "TV B is not approved by TV A's code");
    assert.equal((await tvA("/api/auth/device/poll", { deviceCode: a.data.deviceCode })).data.status, "approved");
  });

  it("refuses unknown codes", async () => {
    const phone = client();
    await phone("/api/auth/start", { email: "second@example.com", mode: "signup" });
    await phone("/api/auth/verify", { code: codes.at(-1) });
    const result = await phone("/api/auth/device/approve", { userCode: "BCDF-GHJK" });
    assert.equal(result.status, 400);
    assert.equal((await client()("/api/auth/device/poll", { deviceCode: "x".repeat(43) })).data.status, "expired");
  });

  it("rejects tokens it didn't sign", async () => {
    const result = await client()("/api/whoami", undefined, { Authorization: "Bearer a.b.c" });
    assert.equal(result.status, 401);
  });
});
