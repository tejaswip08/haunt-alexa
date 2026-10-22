import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// The legacy /api/admin routes accept named ADMIN accounts only. The old shared token is gone: it is set here on purpose, and it
// must still grant nothing. Set before the modules load, since config is read once.
const OLD_TOKEN = "legacy-shared-token-must-not-work-0123";
Object.assign(process.env, {
  HAUNT_PROVIDER: "mock", HAUNT_AGENT: "mock", HAUNT_STORE: "file", HAUNT_DATA_DIR: mkdtempSync(path.join(tmpdir(), "haunt-admin-access-")),
  HAUNT_PREWRITE: "off", HAUNT_ADMIN_TOKEN: OLD_TOKEN,
});

const ROUTES = [
  ["GET", "/stories"],
  ["POST", "/publish"],
  ["POST", "/approve"],
  ["POST", "/reject"],
  ["POST", "/unpublish"],
] as const;

describe("legacy admin routes: named ADMIN only", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let base = "";

  before(async () => {
    const express = (await import("express")).default;
    const { adminRouter, setAdminProfiles } = await import("../src/admin.ts");
    setAdminProfiles({ get: async (sub: string) => ({ role: sub === "ops-admin" ? "ADMIN" : sub === "ops-listener" ? "LISTENER" : undefined }) } as never);
    const app = express();
    app.use(express.json());
    // A verified identity from a test header, as identify() provides in production. The shared token is never an identity.
    app.use((req, res, next) => {
      const sub = req.get("x-test-user");
      if (sub) res.locals.user = { sub, admin: false };
      next();
    });
    app.use("/api/admin", adminRouter);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const call = (method: string, route: string, headers: Record<string, string>) =>
    fetch(base + "/api/admin" + route, {
      method,
      headers: { ...headers, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      body: method === "POST" ? JSON.stringify({ storyId: "us_none" }) : undefined,
    });

  for (const [method, route] of ROUTES) {
    it(`${method} ${route}: a bearer secret alone is refused, and the secret is never echoed`, async () => {
      const res = await call(method, route, { Authorization: `Bearer ${OLD_TOKEN}` });
      assert.equal(res.status, 403);
      assert.doesNotMatch(await res.text(), /legacy-shared-token/);
    });

    it(`${method} ${route}: anonymous and LISTENER callers are refused`, async () => {
      assert.equal((await call(method, route, {})).status, 403, "anonymous");
      assert.equal((await call(method, route, { "x-test-user": "ops-listener" })).status, 403, "listener");
    });
  }

  it("GET /stories: a named ADMIN is allowed", async () => {
    assert.equal((await call("GET", "/stories", { "x-test-user": "ops-admin" })).status, 200);
  });

  it("publish, approve, reject and unpublish are reached only by a named ADMIN (not refused as a missing story)", async () => {
    for (const [method, route] of ROUTES.slice(1)) {
      const res = await call(method, route, { "x-test-user": "ops-admin" });
      assert.notEqual(res.status, 403, `${route} accepts a named ADMIN`);
    }
  });
});
