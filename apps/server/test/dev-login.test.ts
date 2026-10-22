import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { identify, type Authenticator } from "../src/auth.ts";
import { createAuthRouter } from "../src/auth-route.ts";
import { DEV_IDENTITIES } from "../src/dev-identities.ts";
import { createMockAuth } from "../src/mock-auth.ts";
import { ProfileStore, RoleConflictError } from "../src/profiles.ts";
import { createStoryReviewRouter } from "../src/story-review-route.ts";
import { createCreatorStoryRouter } from "../src/user-stories-route.ts";
import type { Role } from "../src/roles.ts";

// Local role identities, through the real auth router, the real mock tokens, the real profile store and the real role
// middleware. The only stand-in is the in-memory table. Nothing reaches DynamoDB, Cognito, or AWS.

function fakeTable() {
  const rows = new Map<string, Record<string, unknown>>();
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "GetCommand") return { Item: rows.has(input.Key.userId) ? structuredClone(rows.get(input.Key.userId)) : undefined };
      if (name === "PutCommand") {
        if (String(input.ConditionExpression).includes("attribute_not_exists") && rows.has(input.Item.userId)) {
          throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
        }
        rows.set(input.Item.userId, structuredClone(input.Item));
        return {};
      }
      return {};
    },
  };
  return { rows, client };
}

const { rows, client } = fakeTable();
const profiles = new ProfileStore(client as never, "haunt-users");
const mock = createMockAuth(() => {});
const authenticate: Authenticator = mock.authenticate;

let server: ReturnType<express.Application["listen"]>;
let base = "";
let devEnabled = true;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      // The mock client, as index.ts passes it in isolated mock mode.
      cognito: mock.cognito,
      secureCookies: false,
      adminGroup: "haunt-admins",
      // The same guard index.ts applies: mock auth, local mode, and the two identities.
      devSignIn: async (identity) => {
        if (!devEnabled) throw new Error("disabled");
        const dev = DEV_IDENTITIES[identity];
        await profiles.provisionRole(dev.sub, dev.role as Role);
        return mock.devLoginAs(dev.email, dev.sub);
      },
    }),
  );
  app.use("/api/me/user-stories", createCreatorStoryRouter({
    authenticate,
    profiles,
    store: { listFor: async () => [] } as never,
    limiter: { hit: () => ({ ok: true }) } as never,
  }));
  app.use("/api/admin/story-submissions", identify(authenticate), createStoryReviewRouter({
    approvals: { listByStatus: async () => [], get: async () => undefined } as never,
    stories: { get: async () => undefined } as never,
    profiles,
    legacyAdmin: false,
  }));
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function signIn(identity: string): Promise<{ status: number; token?: string; body: unknown }> {
  const res = await fetch(`${base}/api/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json", "x-haunt-client": "web" }, body: JSON.stringify({ identity }) });
  const body = await res.json();
  return { status: res.status, token: (body as { accessToken?: string }).accessToken, body };
}
const call = (token: string | undefined, method: string, path: string) =>
  fetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe("provisioning a local role", () => {
  it("creates an absent profile with the identity's role", async () => {
    const dev = DEV_IDENTITIES.listener;
    const profile = await new ProfileStore(fakeTable().client as never, "t").provisionRole(dev.sub, dev.role as Role);
    assert.equal(profile.role, "LISTENER");
  });

  it("keeps an existing profile whose role already matches", async () => {
    const table = fakeTable();
    const store = new ProfileStore(table.client as never, "t");
    await store.provisionRole("local-x", "ADMIN");
    assert.equal((await store.provisionRole("local-x", "ADMIN")).role, "ADMIN");
  });

  it("refuses a different role and changes nothing", async () => {
    const table = fakeTable();
    const store = new ProfileStore(table.client as never, "t");
    await store.provisionRole("local-x", "LISTENER");
    await assert.rejects(store.provisionRole("local-x", "ADMIN"), RoleConflictError);
    assert.equal((await store.get("local-x"))?.role, "LISTENER", "no silent elevation");
  });
});

describe("the development sign-in route", () => {
  it("accepts only the two identity names", async () => {
    assert.equal((await signIn("root")).status, 400);
    assert.equal((await signIn("__proto__")).status, 400);
  });

  it("answers 404 when the development sign-in is not supplied (production)", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/auth", createAuthRouter({ cognito: undefined, secureCookies: false, adminGroup: "haunt-admins" }));
    const srv = app.listen(0);
    await new Promise((resolve) => srv.once("listening", resolve));
    const port = (srv.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity: "admin" }) });
    srv.close();
    assert.equal(res.status, 404);
  });

  it("signs in the listener, whose profile is LISTENER", async () => {
    const result = await signIn("listener");
    assert.equal(result.status, 200);
    assert.equal(rows.get(DEV_IDENTITIES.listener.sub)?.role, "LISTENER");
  });

  it("signs in the admin, whose profile is ADMIN", async () => {
    const result = await signIn("admin");
    assert.equal(result.status, 200);
    assert.equal(rows.get(DEV_IDENTITIES.admin.sub)?.role, "ADMIN");
  });

  it("refuses to sign in an identity whose existing profile has an unexpected role", async () => {
    rows.set(DEV_IDENTITIES.admin.sub, { ...rows.get(DEV_IDENTITIES.admin.sub)!, role: "LISTENER" });
    const result = await signIn("admin");
    assert.equal(result.status, 409);
    assert.equal(rows.get(DEV_IDENTITIES.admin.sub)?.role, "LISTENER", "not elevated, not overwritten");
    rows.set(DEV_IDENTITIES.admin.sub, { ...rows.get(DEV_IDENTITIES.admin.sub)!, role: "ADMIN" });
  });
});

describe("what each local identity may call", () => {
  it("the listener manages their own drafts but cannot review", async () => {
    const token = (await signIn("listener")).token;
    assert.equal((await call(token, "GET", "/api/me/user-stories")).status, 200);
    assert.equal((await call(token, "GET", "/api/admin/story-submissions")).status, 403);
    assert.equal((await call(token, "POST", "/api/admin/story-submissions/us_abcdefghijklmnop%231/approve")).status, 403);
    assert.equal((await call(token, "POST", "/api/admin/story-submissions/us_abcdefghijklmnop%231/reject")).status, 403);
  });

  it("the admin reaches the creator and review routes", async () => {
    const token = (await signIn("admin")).token;
    assert.equal((await call(token, "GET", "/api/me/user-stories")).status, 200);
    assert.equal((await call(token, "GET", "/api/admin/story-submissions")).status, 200);
  });

  it("no request without a token gets through", async () => {
    assert.equal((await call(undefined, "GET", "/api/me/user-stories")).status, 401);
    // The review routes answer anonymous callers 403 ("Sign in as a Haunt admin"), as they always have.
    assert.equal((await call(undefined, "GET", "/api/admin/story-submissions")).status, 403);
  });
});
