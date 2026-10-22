import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

// Offline: mock story writer, temporary data folder, and tokens signed by a local test key
// that stands in for the Cognito user pool. No AWS calls.
const dataDir = await mkdtemp(path.join(tmpdir(), "haunt-review-test-"));
Object.assign(process.env, { HAUNT_PROVIDER: "mock", HAUNT_AGENT: "mock", HAUNT_STORE: "file", HAUNT_DATA_DIR: dataDir, HAUNT_PREWRITE: "off", });
const { createHauntMcpServer } = await import("../src/mcp.ts");
const { createMcpRouter } = await import("../src/mcp-route.ts");
const { createRateLimiter } = await import("../src/rate-limit.ts");
const { adminRouter } = await import("../src/admin.ts");
const { meRouter } = await import("../src/me.ts");
const { authenticatorFor, cognitoAuthenticator, identify } = await import("../src/auth.ts");
const { library } = await import("../src/stories.ts");

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST";
const CLIENT = "test-client";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });

async function token(sub: string, claims: Record<string, unknown> = {}, expires = "1h") {
  return new SignJWT({ token_use: "access", client_id: CLIENT, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(privateKey);
}

let base = "";
let server: ReturnType<express.Express["listen"]>;
let alice: Record<string, string>;
let bob: Record<string, string>;
let admin: Record<string, string>;

before(async () => {
  const authenticate = cognitoAuthenticator({ issuer: ISSUER, clientId: CLIENT, adminGroup: "haunt-admins", keys: jwks });
  const app = express();
  app.use(express.json());
  app.use("/api/me", identify(authenticate), meRouter);
  app.use("/api/admin", identify(authenticate), adminRouter);
  app.use(
    "/api/mcp",
    createMcpRouter({
      access: { kind: "first-party" },
      createServer: createHauntMcpServer,
      authenticate,
      limiter: createRateLimiter([{ windowMs: 60_000, max: 10_000 }]),
    }),
  );
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const bearer = async (sub: string, claims?: Record<string, unknown>) => ({ Authorization: `Bearer ${await token(sub, claims)}` });
  alice = await bearer("user-alice");
  bob = await bearer("user-bob");
  admin = await bearer("user-admin", { "cognito:groups": ["haunt-admins"] });
});
after(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Calls one MCP tool on the first-party route; returns the scene or the error text. */
async function tool(name: string, args: Record<string, unknown>, who: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-11-25",
      "X-Haunt-Client": "web",
      ...who,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  if (res.status !== 200) return { status: res.status, error: text } as const;
  const line = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  const result = JSON.parse(line).result;
  return result.isError
    ? ({ status: 200, error: result.content[0].text as string } as const)
    : ({ status: 200, scene: result.structuredContent as { storyId: string; status: string } } as const);
}

async function api(method: "GET" | "POST", pathname: string, who: Record<string, string>, body?: unknown) {
  const res = await fetch(base + pathname, {
    method,
    headers: { ...who, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function finishedStory(who: Record<string, string>, premise: string) {
  const opening = await tool("start_story", { premise, length: "short" }, who);
  assert.ok(opening.scene, opening.error);
  const ending = await tool("end_story", { storyId: opening.scene.storyId }, who);
  assert.equal(ending.scene?.status, "completed");
  return opening.scene.storyId;
}

describe("Sign-in tokens", () => {
  it("refuses forged, expired, ID and other-client tokens with 401", async () => {
    const { privateKey: other } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ token_use: "access", client_id: CLIENT })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("user-alice")
      .setIssuer(ISSUER)
      .setExpirationTime("1h")
      .sign(other);
    const cases = [
      forged,
      await token("user-alice", {}, "-1m"),
      await token("user-alice", { token_use: "id" }),
      await token("user-alice", { client_id: "someone-else" }),
    ];
    for (const jwt of cases) {
      assert.equal((await api("GET", "/api/me/stories", { Authorization: `Bearer ${jwt}` })).status, 401);
      assert.equal((await tool("start_story", { premise: "x" }, { Authorization: `Bearer ${jwt}` })).status, 401);
    }
  });

  it("never trusts a client-chosen development id in production", async () => {
    const req = { get: (h: string) => ({ "x-haunt-dev-user": "dev-abcdefgh12" })[h.toLowerCase() as "x-haunt-dev-user"] } as never;
    const base = { awsRegion: "us-east-1", adminGroup: "haunt-admins" };
    assert.equal(await authenticatorFor({ ...base, production: true })(req), undefined, "no pool: anonymous");
    assert.equal(
      await authenticatorFor({ ...base, production: true, cognitoUserPoolId: "us-east-1_X", cognitoClientId: "c" })(req),
      undefined,
      "pool: only verified tokens count",
    );
    assert.equal((await authenticatorFor({ ...base, production: false })(req))?.admin, false, "dev ids are never admins");
  });

  it("lists nothing without sign-in or a guest cookie, and keeps other My Stories routes for users", async () => {
    // Guests may list their own stories (by guest cookie; see guest-list.test.ts). No cookie, no stories.
    const anonymous = await api("GET", "/api/me/stories", {});
    assert.equal(anonymous.status, 200);
    assert.deepEqual(anonymous.body.stories, []);
    assert.equal((await api("GET", "/api/me/guest-stories", {})).status, 401);
    assert.equal((await api("POST", "/api/me/claim-guest-stories", {})).status, 401);
  });
});

describe("Two-user isolation and resume", () => {
  let storyId = "";

  it("gives a new story to whoever started it, and nobody else can continue, end or resume it", async () => {
    const opening = await tool("start_story", { premise: "A lighthouse that blinks back", length: "short" }, alice);
    storyId = opening.scene!.storyId;
    for (const who of [bob, {}]) {
      assert.match((await tool("answer_story", { storyId, answer: "Climb the stairs" }, who)).error ?? "", /no longer exists/);
      assert.match((await tool("end_story", { storyId }, who)).error ?? "", /no longer exists/);
      assert.match((await tool("resume_story", { storyId }, who)).error ?? "", /no longer exists/);
    }
  });

  it("lists each user's stories only to them, saved after every turn", async () => {
    await tool("answer_story", { storyId, answer: "Climb the stairs" }, alice);
    const mine = (await api("GET", "/api/me/stories", alice)).body.stories;
    assert.deepEqual(mine.map((s: { storyId: string }) => s.storyId), [storyId]);
    assert.equal(mine[0].scenes, 2, "the answer's scene was saved");
    assert.equal(mine[0].status, "active");
    assert.ok(!JSON.stringify(mine).includes("user-alice"), "no owner ids in responses");
    assert.deepEqual((await api("GET", "/api/me/stories", bob)).body.stories, []);
  });

  it("resumes at the latest scene for its owner, and keeps the owner through to the ending", async () => {
    const resumed = await tool("resume_story", { storyId }, alice);
    assert.equal(resumed.scene?.storyId, storyId);
    await tool("end_story", { storyId }, alice);
    const [story] = (await api("GET", "/api/me/stories", alice)).body.stories;
    assert.equal(story.status, "completed");
    assert.match((await tool("resume_story", { storyId }, bob)).error ?? "", /no longer exists/);
  });

  it("leaves stories from before sign-in open to their id, as before, but nobody can claim them", async () => {
    const legacy = await tool("start_story", { premise: "An anonymous story" }, {});
    const id = legacy.scene!.storyId;
    assert.ok((await tool("resume_story", { storyId: id }, bob)).scene);
    assert.equal((await api("POST", `/api/me/stories/${id}/submit`, bob, { creator: "Bob", summary: "Mine now" })).status, 404);
  });
});

describe("Submission, approval and rejection", () => {
  const submit = (who: Record<string, string>, id: string, creator = "Night Owl", summary = "A lighthouse answers.") =>
    api("POST", `/api/me/stories/${id}/submit`, who, { creator, summary });

  it("submits only finished stories, only by their owner", async () => {
    const opening = await tool("start_story", { premise: "Still being written", length: "short" }, alice);
    assert.equal((await submit(alice, opening.scene!.storyId)).status, 409, "not finished");
    const id = await finishedStory(alice, "The well that hums");
    assert.equal((await submit(bob, id)).status, 404, "someone else's story");
    const first = await submit(alice, id);
    assert.equal(first.body.action, "submitted");
    assert.equal(first.body.story.review.status, "submitted");
    assert.equal((await submit(alice, id, "Night Owl", "Edited.")).body.action, "updated");
  });

  it("lets only admins review: listeners get 403, anonymous callers 401", async () => {
    assert.equal((await api("GET", "/api/admin/stories", bob)).status, 403);
    assert.equal((await api("GET", "/api/admin/stories", {})).status, 403, "anonymous callers are refused");
    assert.equal((await api("GET", "/api/admin/stories", { Authorization: "Bearer any-shared-secret-0123456789" })).status, 403, "a bearer secret is not an admin");
    assert.equal((await api("GET", "/api/admin/stories", admin)).status, 200, "a named ADMIN account can review");
    const id = await finishedStory(bob, "Bob tries to approve himself");
    await submit(bob, id);
    assert.equal((await api("POST", "/api/admin/approve", bob, { storyId: id })).status, 403);
    assert.equal((await api("POST", "/api/admin/reject", bob, { storyId: id, reason: "x" })).status, 403);
    const draft = await finishedStory(bob, "Bob keeps this one to himself");
    const list = (await api("GET", "/api/admin/stories", admin)).body.stories;
    assert.ok(!list.some((s: { storyId: string }) => s.storyId === draft), "unsubmitted drafts stay private");
    const row = list.find((s: { storyId: string }) => s.storyId === id);
    assert.equal(row.review.status, "submitted");
    assert.equal(row.fromListener, true);
  });

  it("publishes a listener's story only by approving it, with their pen name, exactly once", async () => {
    const id = await finishedStory(alice, "The attic radio");
    assert.equal((await api("POST", "/api/admin/publish", admin, { storyId: id, creator: "x", summary: "y" })).status, 409, "not submitted");
    assert.equal((await api("POST", "/api/admin/approve", admin, { storyId: id })).status, 409, "nothing to approve");
    await submit(alice, id, "Static", "A radio that knows your name.");
    const approved = await api("POST", "/api/admin/approve", admin, { storyId: id });
    assert.equal(approved.body.action, "created");
    const entry = await library.get(id);
    assert.equal(entry?.creator, "Static");
    assert.equal(entry?.summary, "A radio that knows your name.");
    assert.ok(!JSON.stringify(entry).includes("user-alice"), "the library never stores who wrote it");
    assert.equal((await api("POST", "/api/admin/approve", admin, { storyId: id })).status, 409, "already approved");
    assert.equal((await submit(alice, id)).status, 409, "already in the library");
    const [mine] = (await api("GET", "/api/me/stories", alice)).body.stories.filter((s: { storyId: string }) => s.storyId === id);
    assert.equal(mine.review.status, "approved");
    // After approval the admin may still edit the entry; it stays one entry.
    const edit = await api("POST", "/api/admin/publish", admin, { storyId: id, creator: "Static", summary: "Edited." });
    assert.equal(edit.body.action, "updated");
    assert.equal((await library.list()).filter((e) => e.episode.storyId === id).length, 1);
  });

  it("rejects with a reason the listener sees, keeps it out of the library, and allows resubmitting", async () => {
    const id = await finishedStory(alice, "The thing under the pier");
    await submit(alice, id);
    assert.equal((await api("POST", "/api/admin/reject", admin, { storyId: id, reason: "" })).status, 400, "reason required");
    assert.equal((await api("POST", "/api/admin/reject", admin, { storyId: id, reason: "Too close to another story." })).body.ok, true);
    assert.equal(await library.get(id), undefined);
    const [mine] = (await api("GET", "/api/me/stories", alice)).body.stories.filter((s: { storyId: string }) => s.storyId === id);
    assert.equal(mine.review.status, "rejected");
    assert.equal(mine.review.reason, "Too close to another story.");
    assert.equal((await api("POST", "/api/admin/reject", admin, { storyId: id, reason: "again" })).status, 409);
    assert.equal((await submit(alice, id)).body.action, "submitted");
    const listed = await tool("list_library", {}, bob);
    assert.ok(listed.scene && !JSON.stringify(listed.scene).includes(id), "pending and rejected stories aren't in the public library");
    assert.match((await tool("play_episode", { storyId: id }, bob)).error ?? "", /no longer exists/);
  });

  it("refuses to approve a second story with identical narration unless the admin confirms", async () => {
    // The mock writer is deterministic: same premise, same path, same narration.
    const first = await finishedStory(alice, "Twin hallways");
    const second = await finishedStory(bob, "Twin hallways");
    await submit(alice, first);
    await submit(bob, second);
    assert.equal((await api("POST", "/api/admin/approve", admin, { storyId: first })).status, 200);
    const dup = await api("POST", "/api/admin/approve", admin, { storyId: second });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.duplicateOf, first);
    assert.equal(await library.get(second), undefined);
    const [bobs] = (await api("GET", "/api/me/stories", bob)).body.stories.filter((s: { storyId: string }) => s.storyId === second);
    assert.equal(bobs.review.status, "submitted", "still waiting; nothing half-done");
    assert.equal((await api("POST", "/api/admin/approve", admin, { storyId: second, allowDuplicate: true })).status, 200);
  });
});
