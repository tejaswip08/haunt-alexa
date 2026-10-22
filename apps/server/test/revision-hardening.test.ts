import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { coverPath, type CoverStorage } from "../src/covers.ts";
import { StoryApprovalStore } from "../src/story-approvals.ts";
import { MAX_PUBLIC_STORY_BYTES, StoryInputSchema, UserStoryError, UserStoryStore, type StoryInput } from "../src/user-stories.ts";
import { createCoverRouter } from "../src/user-stories-route.ts";
import { fakeDynamo, APPROVALS, STORIES } from "./support/fake-dynamo.ts";

// Story size limit, an edit racing a submission, and legacy published-story covers end to end.

const ALICE = "8f1c2d3e-0000-4000-8000-00000000a11c";
const OTHER = "8f1c2d3e-0000-4000-8000-00000000b0b0";
const ADMIN = "8f1c2d3e-0000-4000-8000-0000000ad111";
const HAUNT = "us_legacycccccccccc";
const scene = { sceneIndex: 0, narration: "The door opens by itself.", ending: true };
const input = (title: string, extra: Partial<StoryInput> = {}): StoryInput => StoryInputSchema.parse({ title, author: "Ada", segments: [scene], ...extra });

function build() {
  const dynamo = fakeDynamo();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 21, 12, 0, tick++)).toISOString();
  const stories = new UserStoryStore(dynamo.client as never, STORIES, now);
  const approvals = new StoryApprovalStore(dynamo.client as never, APPROVALS, STORIES, stories, now);
  return { dynamo, stories, approvals };
}

/** A story whose working copy is larger than the public-copy limit: many scenes of long narration. */
function oversized(title: string): StoryInput {
  const long = "x".repeat(4000);
  // A chain, so every scene is reachable: each scene leads to the next, and the last one ends the story.
  const segments = Array.from({ length: 40 }, (_, i) => (i < 39 ? { sceneIndex: i, narration: long, next: i + 1 } : { sceneIndex: i, narration: long, ending: true }));
  return StoryInputSchema.parse({ title, author: "Ada", segments });
}

describe("story size limit", () => {
  it("refuses to submit a story too large to keep a published copy beside its new revision, and creates no review", async () => {
    const t = build();
    const story = await t.stories.create(ALICE, oversized("Too big"));
    await assert.rejects(t.approvals.submit(ALICE, story.hauntId), (e: { code?: string; message: string }) => e.code === "invalid" && /too long/.test(e.message));
    assert.equal(t.dynamo.tables.get(APPROVALS)!.size, 0, "no review record was written");
  });

  it("accepts a story just under the limit", async () => {
    const t = build();
    const story = await t.stories.create(ALICE, input("Small enough"));
    const sub = await t.approvals.submit(ALICE, story.hauntId);
    assert.equal(sub.status, "PENDING_APPROVAL");
    assert.ok(Buffer.byteLength(JSON.stringify(story.story), "utf8") < MAX_PUBLIC_STORY_BYTES);
  });

  it("refuses the first edit of a legacy published story that is too large to keep its public copy", async () => {
    const t = build();
    const legacyId = "us_legacydddddddddd";
    t.dynamo.tables.get(STORIES)!.set(`${ALICE}|${legacyId}`, {
      userId: ALICE, hauntId: legacyId, status: "published", publishedKey: "published", publishedAt: "2026-01-01T00:00:00.000Z",
      version: 2, story: oversized("Big legacy"), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await assert.rejects(t.stories.update(ALICE, legacyId, input("Edited"), 2), (e: UserStoryError) => e.code === "invalid");
    assert.equal(t.dynamo.tables.get(STORIES)!.get(`${ALICE}|${legacyId}`)!.version, 2, "the story was not changed");
  });
});

describe("an edit racing a submission", () => {
  it("a submission whose story changed during the transaction is refused, and no review is recorded", async () => {
    const t = build();
    const story = await t.stories.create(ALICE, input("Version one"));
    // The creator edits between the submission's read and its transaction.
    t.dynamo.hooks.beforeTransact = () => {
      const key = `${ALICE}|${story.hauntId}`;
      const row = t.dynamo.tables.get(STORIES)!.get(key)!;
      t.dynamo.tables.get(STORIES)!.set(key, { ...row, version: row.version + 1, story: input("Version two") });
    };
    await assert.rejects(t.approvals.submit(ALICE, story.hauntId), (e: { code?: string }) => e.code === "conflict");
    assert.equal(t.dynamo.tables.get(APPROVALS)!.size, 0, "no review record for a revision that was not submitted");
    assert.equal(t.dynamo.tables.get(STORIES)!.get(`${ALICE}|${story.hauntId}`)!.story.title, "Version two", "the creator's edit stands");
  });

  it("an edit after a successful submission withdraws that review, so it cannot be approved as the new text", async () => {
    const t = build();
    const story = await t.stories.create(ALICE, input("Version one"));
    const sub = await t.approvals.submit(ALICE, story.hauntId);
    await t.stories.update(ALICE, story.hauntId, input("Version two"), story.version);
    await t.approvals.withdrawPending(ALICE, story.hauntId, "edited");
    await assert.rejects(t.approvals.approve(ADMIN, sub.submissionId), (e: { code?: string }) => e.code === "conflict");
  });
});

describe("legacy published-story covers, end to end", () => {
  const key = `covers/${ALICE}/${HAUNT}/0a1b2c3d-0000-4000-8000-000000000009.png`;
  const otherKey = `covers/${ALICE}/${HAUNT}/0a1b2c3d-0000-4000-8000-00000000000a.png`;
  let t: ReturnType<typeof build>;
  let server: ReturnType<express.Application["listen"]>;
  let base = "";

  before(async () => {
    t = build();
    // A story published before approval records existed: listed, its cover is the one stored in the row.
    t.dynamo.tables.get(STORIES)!.set(`${ALICE}|${HAUNT}`, {
      userId: ALICE, hauntId: HAUNT, status: "published", publishedKey: "published", publishedAt: "2026-01-01T00:00:00.000Z",
      version: 3, story: input("Legacy", { coverUrl: coverPath(key) }), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const bucket = new Map<string, Buffer>([[key, Buffer.from("legacy-cover-bytes")], [otherKey, Buffer.from("new-cover-bytes")]]);
    const storage: CoverStorage = {
      async presignUpload() { return { url: "https://bucket.example.test/", fields: {} }; },
      async exists(k) { return bucket.has(k); },
      async read(k) { const b = bucket.get(k); return b ? Readable.from([b]) : undefined; },
    };
    const app = express();
    app.use((req, res, next) => {
      const sub = req.headers["x-test-user"];
      if (typeof sub === "string") res.locals.user = { sub, admin: false };
      next();
    });
    app.use("/api/covers", createCoverRouter({ storage, stories: t.stories, approvals: t.approvals, isAdmin: async () => false }));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const get = (path: string, who?: string) => fetch(`${base}/api/covers/${path}`, { headers: who ? { "x-test-user": who } : {}, redirect: "manual" });

  it("serves a legacy published story's cover to anyone, with no approval record", async () => {
    const res = await get(key);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "legacy-cover-bytes");
  });

  it("refuses a cover that is not the story's current cover, and a missing one, to an unauthorized viewer", async () => {
    assert.equal((await get(`covers/${ALICE}/${HAUNT}/0a1b2c3d-0000-4000-8000-00000000000b.png`)).status, 404);
    assert.equal((await get(otherKey)).status, 404, "a cover not on the story is not public");
  });

  it("keeps the old cover public after the creator changes it, and does not expose the new one", async () => {
    await t.stories.update(ALICE, HAUNT, input("Legacy edited", { coverUrl: coverPath(otherKey) }), 3);
    assert.equal((await get(key)).status, 200, "the approved cover stays public");
    assert.equal((await get(otherKey)).status, 404, "the unreviewed cover is not public");
    assert.equal((await get(otherKey, OTHER)).status, 404, "another signed-in user cannot read it either");
  });

  it("lets the owner read their own pending cover", async () => {
    const res = await get(otherKey, ALICE);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "new-cover-bytes");
  });
});
