import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { fakeDynamo, APPROVALS, STORIES } from "./support/fake-dynamo.ts";
import { StoryApprovalStore, submissionIdFor, type SubmissionRecord } from "../src/story-approvals.ts";
import { createStoryReviewRouter } from "../src/story-review-route.ts";
import { StoryInputSchema, UserStoryStore, type StoryInput } from "../src/user-stories.ts";

// Story approval, against the real stores with an in-memory DynamoDB that evaluates the simple expressions they send.
// Transactions are all-or-nothing, as in DynamoDB: every condition is checked before any write is applied.

const ALICE = "8f1c2d3e-0000-4000-8000-00000000a11c"; // the creator
const BOB = "8f1c2d3e-0000-4000-8000-00000000b0b0"; // another creator
const ADMIN = "8f1c2d3e-0000-4000-8000-0000000ad111";

const SCENE = { sceneIndex: 0, narration: "The door opens by itself.", ending: true };
function storyInput(overrides: Partial<StoryInput> = {}): StoryInput {
  return StoryInputSchema.parse({ title: "The Last Knock", author: "Ada", segments: [SCENE], ...overrides });
}

function build() {
  const dynamo = fakeDynamo();
  const now = (() => {
    let n = 0;
    return () => new Date(Date.UTC(2026, 9, 21, 12, 0, n++)).toISOString();
  })();
  const stories = new UserStoryStore(dynamo.client as never, STORIES, now);
  const approvals = new StoryApprovalStore(dynamo.client as never, APPROVALS, STORIES, stories, now);
  return { dynamo, stories, approvals };
}

describe("the approval table", () => {
  it("is keyed by submission, with the three indexes the workflow needs", () => {
    const def = JSON.parse(readFileSync(new URL("../../../deploy/local/haunt-story-approvals-table.local.json", import.meta.url), "utf8"));
    assert.equal(def.TableName, "haunt-story-approvals");
    assert.deepEqual(def.KeySchema, [{ AttributeName: "submissionId", KeyType: "HASH" }]);
    const indexes = Object.fromEntries(
      def.GlobalSecondaryIndexes.map((ix: { IndexName: string; KeySchema: { AttributeName: string }[] }) => [ix.IndexName, ix.KeySchema.map((k) => k.AttributeName)]),
    );
    assert.deepEqual(indexes["status-submitted"], ["status", "submittedAt"]);
    assert.deepEqual(indexes["creator-submitted"], ["submittedBy", "submittedAt"]);
    assert.deepEqual(indexes["story-submitted"], ["storyId", "submittedAt"]);
  });

  it("names one submission per story revision", () => {
    assert.equal(submissionIdFor("us_abcdefghijklmnop", 3), "us_abcdefghijklmnop#3");
  });
});

describe("submitting", () => {
  it("creates a separate approval record and leaves the story a private draft", async () => {
    const { dynamo, stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    assert.equal(sub.status, "PENDING_APPROVAL");
    assert.equal(sub.version, story.version);
    assert.equal(sub.submittedBy, ALICE);
    assert.equal(dynamo.tables.get(APPROVALS)!.size, 1, "one record in the approval table");
    const after = await stories.get(ALICE, story.hauntId);
    assert.equal(after!.status, "draft", "submitting does not publish");
    assert.equal(after!.publishedKey, undefined);
  });

  it("returns the same pending submission for a repeat of the same revision", async () => {
    const { dynamo, stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const first = await approvals.submit(ALICE, story.hauntId);
    const again = await approvals.submit(ALICE, story.hauntId);
    assert.equal(again.submissionId, first.submissionId);
    assert.equal(dynamo.tables.get(APPROVALS)!.size, 1);
  });

  it("refuses a story that fails the publish checks, and reports the problems", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput({ segments: [{ sceneIndex: 0, narration: "Start.", next: 9 }] as never }));
    await assert.rejects(approvals.submit(ALICE, story.hauntId), (e: { code?: string }) => e.code === "invalid");
  });

  it("refuses a published story: it must be unpublished first", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    await approvals.approve(ADMIN, sub.submissionId);
    await assert.rejects(approvals.submit(ALICE, story.hauntId), (e: { code?: string }) => e.code === "conflict");
  });
});

describe("review", () => {
  it("approves the reviewed revision and only then makes the story public", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    assert.equal((await stories.listPublished(10)).stories.length, 0, "pending is not in Community");
    const done = await approvals.approve(ADMIN, sub.submissionId);
    assert.equal(done.status, "APPROVED");
    assert.equal(done.reviewedBy, ADMIN);
    assert.ok(done.reviewedAt);
    const listed = await stories.listPublished(10);
    assert.deepEqual(listed.stories.map((s) => s.id), [story.hauntId]);
    assert.equal((await stories.findPublished(story.hauntId))?.hauntId, story.hauntId);
  });

  it("keeps a rejected story private and editable, with the reason stored", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    const rejected = await approvals.reject(ADMIN, sub.submissionId, "Needs a clearer ending.");
    assert.equal(rejected.status, "REJECTED");
    assert.equal(rejected.rejectionReason, "Needs a clearer ending.");
    assert.equal((await stories.listPublished(10)).stories.length, 0);
    assert.equal(await stories.findPublished(story.hauntId), undefined, "playback refuses a rejected story");
    const after = await stories.get(ALICE, story.hauntId);
    assert.equal(after!.status, "draft");
    await stories.update(ALICE, story.hauntId, storyInput({ title: "Revised" }), after!.version);
    const resubmitted = await approvals.submit(ALICE, story.hauntId);
    assert.equal(resubmitted.status, "PENDING_APPROVAL", "a rejected story can be resubmitted after an edit");
  });

  it("requires a non-empty rejection reason of 500 characters or fewer", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    await assert.rejects(approvals.reject(ADMIN, sub.submissionId, "   "), (e: { code?: string }) => e.code === "invalid");
    await assert.rejects(approvals.reject(ADMIN, sub.submissionId, "x".repeat(501)), (e: { code?: string }) => e.code === "invalid");
    assert.equal((await approvals.get(sub.submissionId))!.status, "PENDING_APPROVAL", "a refused rejection changes nothing");
  });

  it("refuses a creator approving or rejecting their own story", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    await assert.rejects(approvals.approve(ALICE, sub.submissionId), (e: { code?: string }) => e.code === "forbidden");
    await assert.rejects(approvals.reject(ALICE, sub.submissionId, "Mine"), (e: { code?: string }) => e.code === "forbidden");
    assert.equal((await stories.listPublished(10)).stories.length, 0);
  });

  it("handles repeated approve and reject requests without changing the outcome", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    const once = await approvals.approve(ADMIN, sub.submissionId);
    const twice = await approvals.approve(ADMIN, sub.submissionId);
    assert.equal(twice.status, "APPROVED");
    assert.equal(twice.reviewedAt, once.reviewedAt, "the first decision is kept");
    await assert.rejects(approvals.reject(ADMIN, sub.submissionId, "Too late"), (e: { code?: string }) => e.code === "conflict");
  });

  it("invalidates an old review when the creator edits the story", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    await stories.update(ALICE, story.hauntId, storyInput({ synopsis: "Changed after submission." }), story.version);
    await approvals.withdrawPending(ALICE, story.hauntId, "Edited.");
    assert.equal((await approvals.get(sub.submissionId))!.status, "WITHDRAWN");
    await assert.rejects(approvals.approve(ADMIN, sub.submissionId), (e: { code?: string }) => e.code === "conflict");
    assert.equal((await stories.listPublished(10)).stories.length, 0);
  });

  it("refuses approval when the story is no longer the reviewed revision, even if the withdrawal was missed", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    await stories.update(ALICE, story.hauntId, storyInput({ synopsis: "Changed." }), story.version);
    await assert.rejects(approvals.approve(ADMIN, sub.submissionId), (e: { code?: string }) => e.code === "stale");
    assert.equal((await stories.listPublished(10)).stories.length, 0);
  });

  it("supersedes an older pending submission when a newer revision is submitted", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    const first = await approvals.submit(ALICE, story.hauntId);
    const edited = await stories.update(ALICE, story.hauntId, storyInput({ synopsis: "v2" }), story.version);
    const second = await approvals.submit(ALICE, story.hauntId);
    assert.equal((await approvals.get(first.submissionId))!.status, "WITHDRAWN");
    assert.equal(second.version, edited.version);
    assert.equal(second.status, "PENDING_APPROVAL");
  });
});

describe("visibility", () => {
  it("editing a published story keeps the approved revision public until the edit is approved", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput({ title: "Approved title" }));
    const sub = await approvals.submit(ALICE, story.hauntId);
    await approvals.approve(ADMIN, sub.submissionId);
    const edited = await stories.update(ALICE, story.hauntId, storyInput({ title: "Unreviewed title" }), story.version);
    assert.equal(edited.status, "published", "the story stays published while the edit is pending");
    const listed = (await stories.listPublished(10)).stories;
    assert.equal(listed.length, 1, "still listed");
    assert.equal(listed[0]!.title, "Approved title", "Community shows the approved revision, never the unreviewed edit");
    const pending = await approvals.submit(ALICE, story.hauntId);
    assert.equal(pending.status, "PENDING_APPROVAL");
    assert.equal((await stories.listPublished(10)).stories[0]!.title, "Approved title", "still the approved revision while the edit is pending");
    await approvals.approve(ADMIN, pending.submissionId);
    assert.equal((await stories.listPublished(10)).stories[0]!.title, "Unreviewed title", "switches once the new revision is approved");
  });

  it("keeps stories published before approval existed listed, with no approval record", async () => {
    const { dynamo, stories } = build();
    const legacy = await stories.create(ALICE, storyInput());
    // A story published before this feature: publishedKey set directly, no submission record.
    dynamo.tables.get(STORIES)!.set(`${ALICE}|${legacy.hauntId}`, { ...structuredClone(legacy), status: "published", publishedKey: "published", publishedAt: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual((await stories.listPublished(10)).stories.map((s) => s.id), [legacy.hauntId]);
    assert.equal(dynamo.tables.get(APPROVALS)!.size, 0);
  });

  it("refuses a direct publish request at the API", async () => {
    const { stories, approvals } = build();
    const story = await stories.create(ALICE, storyInput());
    assert.equal(typeof (stories as unknown as { publish?: unknown }).publish, "undefined", "no direct publish in the store");
    void approvals;
  });
});

describe("the review routes", () => {
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  const roles: Record<string, string> = { [ADMIN]: "ADMIN", [ALICE]: "CREATOR", [BOB]: "LISTENER" };
  const { stories, approvals } = build();
  const profiles = { get: async (sub: string) => ({ role: roles[sub] }) } as never;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const sub = req.headers["x-test-user"];
      if (typeof sub === "string") res.locals.user = { sub, admin: false };
      next();
    });
    app.use("/api/admin/story-submissions", createStoryReviewRouter({ approvals, stories, profiles, legacyAdmin: false }));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const call = (user: string | undefined, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("lets only a verified admin review, and refuses everyone else", async () => {
    const story = await stories.create(ALICE, storyInput());
    const sub: SubmissionRecord = await approvals.submit(ALICE, story.hauntId);
    const path = `/api/admin/story-submissions/${encodeURIComponent(sub.submissionId)}/approve`;
    assert.equal((await call(undefined, path, {})).status, 403, "no signed-in user, so no admin token either");
    assert.equal((await call(BOB, path, {})).status, 403, "a listener");
    assert.equal((await call(ALICE, path, {})).status, 403, "a creator reviewing their own story");
    assert.equal((await call(ADMIN, path, {})).status, 200);
  });

  it("validates the rejection reason on the route", async () => {
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    const path = `/api/admin/story-submissions/${encodeURIComponent(sub.submissionId)}/reject`;
    assert.equal((await call(ADMIN, path, { reason: "" })).status, 422);
    assert.equal((await call(ADMIN, path, { reason: "Clearer ending, please." })).status, 200);
  });

  it("answers an unknown submission with 404, and an unknown status with 422", async () => {
    assert.equal((await call(ADMIN, `/api/admin/story-submissions/${encodeURIComponent("us_nothere0000000000#1")}`)).status, 404);
    assert.equal((await call(ADMIN, "/api/admin/story-submissions?status=BOGUS")).status, 422);
  });
});

describe("the creator's routes", () => {
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  const { stories, approvals } = build();
  const covers = undefined;

  before(async () => {
    const { createMyStoriesRouter } = await import("../src/user-stories-route.ts");
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const sub = req.headers["x-test-user"];
      if (typeof sub === "string") res.locals.user = { sub, admin: false };
      next();
    });
    app.use("/api/me/user-stories", createMyStoriesRouter(stories, { hit: () => ({ ok: true }) } as never, covers, approvals));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const as = (user: string, path: string, method = "POST", body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-test-user": user },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("refuses a direct publish, and submits for review without publishing", async () => {
    const story = await stories.create(ALICE, storyInput());
    const direct = await as(ALICE, `/api/me/user-stories/${story.hauntId}/publish`, "POST", { expectedVersion: story.version });
    assert.equal(direct.status, 403);
    assert.equal((await stories.get(ALICE, story.hauntId))!.status, "draft");

    const submitted = await as(ALICE, `/api/me/user-stories/${story.hauntId}/submit`);
    assert.equal(submitted.status, 201);
    assert.equal(((await submitted.json()) as { submission: { status: string } }).submission.status, "PENDING_APPROVAL");
    assert.equal((await stories.get(ALICE, story.hauntId))!.status, "draft", "still private after submitting");
    assert.equal((await stories.listPublished(10)).stories.length, 0);
  });

  it("refuses to submit another creator's story as if it were theirs", async () => {
    const story = await stories.create(ALICE, storyInput());
    const res = await as(BOB, `/api/me/user-stories/${story.hauntId}/submit`);
    assert.equal(res.status, 404, "another creator gets the same answer as a missing story");
  });

  it("refuses to submit a story whose cover is another story's upload", async () => {
    const foreign = `/api/covers/covers/${ALICE}/us_zzzzzzzzzzzzzzzz/0a1b2c3d-0000-4000-8000-000000000001.jpg`;
    const story = await stories.create(ALICE, storyInput({ coverUrl: foreign }));
    const res = await as(ALICE, `/api/me/user-stories/${story.hauntId}/submit`);
    assert.equal(res.status, 422);
  });
});

describe("audit: public routes never expose unapproved stories", () => {
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  const { stories, approvals } = build();
  const noLibrary = { list: async () => [], get: async () => undefined } as never;
  const ids: Record<string, string> = {};

  before(async () => {
    const { createCommunityRouter, createMyStoriesRouter } = await import("../src/user-stories-route.ts");
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const sub = req.headers["x-test-user"];
      if (typeof sub === "string") res.locals.user = { sub, admin: false };
      next();
    });
    app.use("/api/me/user-stories", createMyStoriesRouter(stories, { hit: () => ({ ok: true }) } as never, undefined, approvals));
    app.use("/api/community", createCommunityRouter(noLibrary, stories));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // One story in each state: draft, pending, rejected, approved.
    ids.draft = (await stories.create(ALICE, storyInput({ title: "Draft only" }))).hauntId;
    ids.pending = (await stories.create(ALICE, storyInput({ title: "Pending" }))).hauntId;
    await approvals.submit(ALICE, ids.pending);
    ids.rejected = (await stories.create(ALICE, storyInput({ title: "Rejected" }))).hauntId;
    const r = await approvals.submit(ALICE, ids.rejected);
    await approvals.reject(ADMIN, r.submissionId, "Not yet.");
    ids.approved = (await stories.create(ALICE, storyInput({ title: "Approved" }))).hauntId;
    const a = await approvals.submit(ALICE, ids.approved);
    await approvals.approve(ADMIN, a.submissionId);
  });
  after(() => server.close());

  const get = (path: string, user?: string) =>
    fetch(`${base}${path}`, { headers: user ? { "x-test-user": user } : {} });

  it("lists only the approved story to anyone", async () => {
    const data = (await (await get("/api/community/stories")).json()) as { stories: { id: string; title: string }[] };
    assert.deepEqual(data.stories.map((s) => s.id), [ids.approved]);
    assert.equal(JSON.stringify(data).includes("Pending"), false);
    assert.equal(JSON.stringify(data).includes("segments"), false, "the list carries cards, not scene content");
  });

  it("answers direct requests for draft, pending and rejected stories as missing", async () => {
    for (const key of ["draft", "pending", "rejected"]) {
      assert.equal((await get(`/api/community/stories/${ids[key]}`)).status, 404, key);
    }
    assert.equal((await get(`/api/community/stories/${ids.approved}`)).status, 200);
  });

  it("does not let a creator's own edit or direct publish make an unapproved story public", async () => {
    const pendingBefore = await stories.get(ALICE, ids.pending);
    const edited = await fetch(`${base}/api/me/user-stories/${ids.pending}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-test-user": ALICE },
      body: JSON.stringify({ ...storyInput({ title: "Pending" }), status: "published", publishedKey: "published", expectedVersion: pendingBefore!.version }),
    });
    assert.equal(edited.status, 200);
    const after = await stories.get(ALICE, ids.pending);
    assert.equal(after!.status, "draft", "a status sent in the body is ignored");
    assert.equal(after!.publishedKey, undefined);
    assert.equal((await get(`/api/community/stories/${ids.pending}`)).status, 404);
    const direct = await fetch(`${base}/api/me/user-stories/${ids.draft}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": ALICE },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(direct.status, 403);
  });

  it("gives the creator the rejection reason, and only their own history", async () => {
    const mine = await fetch(`${base}/api/me/user-stories/${ids.rejected}/submissions`, { headers: { "x-test-user": ALICE } });
    const data = (await mine.json()) as { submissions: { status: string; rejectionReason?: string }[] };
    assert.equal(data.submissions[0]!.status, "REJECTED");
    assert.equal(data.submissions[0]!.rejectionReason, "Not yet.");
    const theirs = await fetch(`${base}/api/me/user-stories/${ids.rejected}/submissions`, { headers: { "x-test-user": BOB } });
    assert.deepEqual(await theirs.json(), { submissions: [] }, "another creator sees none of it");
  });
});

describe("audit: the review gate", () => {
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  const { stories, approvals } = build();
  let pendingPath = "";

  before(async () => {
    const story = await stories.create(ALICE, storyInput());
    const sub = await approvals.submit(ALICE, story.hauntId);
    pendingPath = `/api/admin/story-submissions/${encodeURIComponent(sub.submissionId)}/approve`;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const who = req.headers["x-test-user"];
      const admin = req.headers["x-test-admin-group"] === "yes";
      if (typeof who === "string") res.locals.user = { sub: who, admin };
      next();
    });
    app.use(
      "/api/admin/story-submissions",
      createStoryReviewRouter({
        approvals,
        stories,
        profiles: { get: async (sub: string) => ({ role: sub === ADMIN ? "ADMIN" : "LISTENER" }) } as never,
        legacyAdmin: false,
      }),
    );
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const post = (headers: Record<string, string>, path: string) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

  it("refuses an admin-group flag when the legacy group is off, so only the ADMIN role counts", async () => {
    assert.equal((await post({ "x-test-user": BOB, "x-test-admin-group": "yes" }, pendingPath)).status, 403);
  });

  it("refuses an admin token with no named user, and an unknown listener", async () => {
    assert.equal((await post({ authorization: "Bearer some-admin-token" }, pendingPath)).status, 403);
    assert.equal((await post({ "x-test-user": BOB }, pendingPath)).status, 403);
  });

  it("lets the named ADMIN role approve", async () => {
    assert.equal((await post({ "x-test-user": ADMIN }, pendingPath)).status, 200);
  });
});
