import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { coverKey, type CoverStorage } from "../src/covers.ts";
import { createStoryReviewRouter } from "../src/story-review-route.ts";
import { StoryInputSchema, type StoryInput, type UserStoryStore } from "../src/user-stories.ts";
import { createCreatorStoryRouter } from "../src/user-stories-route.ts";
import type { Authenticator } from "../src/auth.ts";

// The My Stories mount as index.ts builds it (createCreatorStoryRouter), with real route paths and the real role middleware.
// Only the storage is a stand-in. The identity comes from a test header, verified the way the server verifies it: unknown
// callers are anonymous, and each profile's role comes from the profile store.

const ROLES: Record<string, string> = { "u-listener": "LISTENER", "u-creator": "CREATOR", "u-admin": "ADMIN" };
const HAUNT = "us_abcdefghijklmnop";
const authenticate: Authenticator = async (req) => {
  const sub = req.get("x-test-user");
  return sub && sub in ROLES ? { sub, admin: false } : undefined;
};
const profiles = { get: async (sub: string) => (sub in ROLES ? { role: ROLES[sub] } : undefined) } as never;

const scene = { sceneIndex: 0, narration: "The door opens.", ending: true };
const input = (): StoryInput => StoryInputSchema.parse({ title: "The Last Knock", author: "Ada", segments: [scene] });

/** A stand-in store where the caller's own story exists, so the handlers that run after the gate have something to do. */
const store = {
  listFor: async () => [],
  get: async (owner: string, hauntId: string) =>
    hauntId === HAUNT ? { hauntId, userId: owner, status: "draft", version: 1, story: { ...input(), coverUrl: "" } } : undefined,
  create: async (_owner: string, body: StoryInput) => ({ hauntId: HAUNT, status: "draft", version: 1, story: body }),
  update: async (_owner: string, hauntId: string, body: StoryInput, version: number) => ({ hauntId, status: "draft", version: version + 1, story: body }),
} as unknown as UserStoryStore;
const approvals = {
  submit: async () => ({ submissionId: `${HAUNT}#1`, status: "PENDING_APPROVAL" }),
  listForStory: async () => [],
  listForCreator: async () => [],
  withdrawPending: async () => 0,
  listByStatus: async () => [],
  get: async () => undefined,
} as never;
const covers: CoverStorage = {
  async presignUpload(key) {
    return { url: "https://bucket.example.test/", fields: { key } };
  },
  async exists() {
    return false;
  },
  async read() {
    return undefined;
  },
};

let server: ReturnType<express.Application["listen"]>;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/me/user-stories",
    createCreatorStoryRouter({ authenticate, profiles, store, limiter: { hit: () => ({ ok: true }) } as never, covers, approvals }),
  );
  // The review routes, unchanged, mounted as index.ts mounts them.
  app.use(
    "/api/admin/story-submissions",
    (await import("../src/auth.ts")).identify(authenticate),
    createStoryReviewRouter({ approvals, stories: store, profiles, legacyAdmin: false }),
  );
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = (user: string | undefined, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const creatorRoutes = [
  { name: "list", method: "GET", path: "/api/me/user-stories" },
  { name: "create", method: "POST", path: "/api/me/user-stories", body: input() },
  { name: "edit", method: "PUT", path: `/api/me/user-stories/${HAUNT}`, body: { ...input(), expectedVersion: 1 } },
  { name: "submit", method: "POST", path: `/api/me/user-stories/${HAUNT}/submit` },
  { name: "submissions", method: "GET", path: `/api/me/user-stories/${HAUNT}/submissions` },
  { name: "cover upload", method: "POST", path: `/api/me/user-stories/${HAUNT}/cover`, body: { contentType: "image/png", size: 1024 } },
];

describe("unauthenticated requests", () => {
  for (const route of creatorRoutes) {
    it(`cannot ${route.name}`, async () => {
      const res = await call(undefined, route.method, route.path, route.body);
      assert.equal(res.status, 401);
    });
  }
});

describe("LISTENER requests", () => {
  // A signed-in listener manages their own drafts. Only sending a story toward the library needs a creator role.
  for (const route of creatorRoutes.filter((r) => r.name !== "submit")) {
    it(`may ${route.name} their own story`, async () => {
      const res = await call("u-listener", route.method, route.path, route.body);
      assert.notEqual(res.status, 401);
      assert.notEqual(res.status, 403, `${route.name} is open to every signed-in user`);
    });
  }

  it("gets 403 on submit, and the refusal says nothing about the resource", async () => {
    const res = await call("u-listener", "POST", `/api/me/user-stories/${HAUNT}/submit`);
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /HAUNT|us_|story/i, "the refusal says nothing about the resource");
  });
});

describe("creator roles", () => {
  it("lets a CREATOR list, create, edit, submit, and upload a cover for their own story", async () => {
    assert.equal((await call("u-creator", "GET", "/api/me/user-stories")).status, 200);
    assert.equal((await call("u-creator", "POST", "/api/me/user-stories", input())).status, 201);
    assert.equal((await call("u-creator", "PUT", `/api/me/user-stories/${HAUNT}`, { ...input(), expectedVersion: 1 })).status, 200);
    assert.equal((await call("u-creator", "POST", `/api/me/user-stories/${HAUNT}/submit`)).status, 201);
    assert.equal((await call("u-creator", "POST", `/api/me/user-stories/${HAUNT}/cover`, { contentType: "image/png", size: 1024 })).status, 200);
  });

  it("lets an ADMIN use the creator routes too, since ADMIN is in CREATOR_ROLES", async () => {
    assert.equal((await call("u-admin", "GET", "/api/me/user-stories")).status, 200);
  });

  it("does not let a creator approve or reject a submission, however they call the review routes", async () => {
    const res = await call("u-creator", "POST", `/api/admin/story-submissions/${encodeURIComponent(`${HAUNT}#1`)}/approve`, {});
    assert.equal(res.status, 403);
    assert.equal((await call("u-creator", "GET", "/api/admin/story-submissions")).status, 403);
  });

  it("lets an ADMIN review, with the review rules unchanged", async () => {
    assert.equal((await call("u-admin", "GET", "/api/admin/story-submissions")).status, 200);
  });
});

describe("the cover key still belongs to the caller", () => {
  it("issues a key under the creator's own story and no other", async () => {
    const res = await call("u-creator", "POST", `/api/me/user-stories/${HAUNT}/cover`, { contentType: "image/png", size: 1024 });
    const body = (await res.json()) as { coverUrl: string };
    assert.match(body.coverUrl, new RegExp(`^/api/covers/covers/u-creator/${HAUNT}/`));
    assert.ok(coverKey("u-creator", HAUNT, "image/png").startsWith("covers/u-creator/"));
  });
});
