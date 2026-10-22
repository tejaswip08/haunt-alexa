import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { fakeDynamo, APPROVALS, STORIES } from "./support/fake-dynamo.ts";
import { StoryApprovalStore } from "../src/story-approvals.ts";
import { createCommunityRouter } from "../src/user-stories-route.ts";
import { publicRevisionOf, StoryInputSchema, UserStoryStore, type StoryInput } from "../src/user-stories.ts";

// A published story's approved revision and its pending revision, through the real stores and the public Community routes.
// The in-memory table evaluates the real expressions, so the approval and visibility rules are the ones that ship.

const ALICE = "8f1c2d3e-0000-4000-8000-00000000a11c";
const BOB = "8f1c2d3e-0000-4000-8000-00000000b0b0";
const ADMIN = "8f1c2d3e-0000-4000-8000-0000000ad111";
const scene = { sceneIndex: 0, narration: "The door opens by itself.", ending: true };
const input = (title: string, synopsis = "A story."): StoryInput => StoryInputSchema.parse({ title, author: "Ada", synopsis, segments: [scene] });

function build() {
  const dynamo = fakeDynamo();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 21, 12, 0, tick++)).toISOString();
  const stories = new UserStoryStore(dynamo.client as never, STORIES, now);
  const approvals = new StoryApprovalStore(dynamo.client as never, APPROVALS, STORIES, stories, now);
  return { dynamo, stories, approvals };
}

/** A story published with the given title, through the real submit and approve path. */
async function published(t: ReturnType<typeof build>, title: string) {
  const story = await t.stories.create(ALICE, input(title));
  const sub = await t.approvals.submit(ALICE, story.hauntId);
  await t.approvals.approve(ADMIN, sub.submissionId);
  return story.hauntId;
}

/** A row written directly, as a story published before approval records existed would be. */
function legacyPublished(t: ReturnType<typeof build>, hauntId: string, title: string) {
  const row = { userId: ALICE, hauntId, status: "published", publishedKey: "published", publishedAt: "2026-01-01T00:00:00.000Z", version: 4, story: input(title), createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  t.dynamo.tables.get(STORIES)!.set(`${ALICE}|${hauntId}`, row);
}

const titlesOf = async (t: ReturnType<typeof build>) => (await t.stories.listPublished(10)).stories.map((s) => s.title);

describe("the approved revision stays public while a new revision is pending", () => {
  it("keeps the approved revision listed and playable while an edit is submitted and pending", async () => {
    const t = build();
    const id = await published(t, "Approved v1");
    await t.stories.update(ALICE, id, input("Pending v2"), 1);
    const pending = await t.approvals.submit(ALICE, id);
    assert.equal(pending.status, "PENDING_APPROVAL");
    assert.deepEqual(await titlesOf(t), ["Approved v1"]);
    const record = await t.stories.findPublished(id);
    assert.equal(publicRevisionOf(record!)?.story.title, "Approved v1", "playback reads the approved revision");
    assert.equal(record!.story.title, "Pending v2", "the working copy is kept for the creator");
  });

  it("rejecting the pending revision keeps the approved revision public and records the reason", async () => {
    const t = build();
    const id = await published(t, "Approved v1");
    await t.stories.update(ALICE, id, input("Pending v2"), 1);
    const sub = await t.approvals.submit(ALICE, id);
    await t.approvals.reject(ADMIN, sub.submissionId, "Tighten the ending.");
    assert.deepEqual(await titlesOf(t), ["Approved v1"]);
    assert.equal((await t.approvals.get(sub.submissionId))?.rejectionReason, "Tighten the ending.");
    assert.equal((await t.stories.findPublished(id))?.publicStory?.version, 1);
  });

  it("approving the pending revision switches public visibility to it, atomically", async () => {
    const t = build();
    const id = await published(t, "Approved v1");
    await t.stories.update(ALICE, id, input("Pending v2"), 1);
    const sub = await t.approvals.submit(ALICE, id);
    await t.approvals.approve(ADMIN, sub.submissionId);
    assert.deepEqual(await titlesOf(t), ["Pending v2"]);
    const record = await t.stories.findPublished(id);
    assert.equal(record?.publicStory?.version, 2);
    assert.equal(record?.publicStory?.story.title, "Pending v2");
  });
});

describe("a draft that was never published stays private until approved", () => {
  it("is absent from Community and answers as missing until it is approved", async () => {
    const t = build();
    const story = await t.stories.create(ALICE, input("Never published"));
    assert.deepEqual(await titlesOf(t), []);
    assert.equal(await t.stories.findPublished(story.hauntId), undefined);
    const sub = await t.approvals.submit(ALICE, story.hauntId);
    assert.deepEqual(await titlesOf(t), [], "pending is still private");
    await t.approvals.approve(ADMIN, sub.submissionId);
    assert.deepEqual(await titlesOf(t), ["Never published"]);
  });
});

describe("public Community and playback APIs", () => {
  let t: ReturnType<typeof build>;
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  let pendingId = "";
  let draftId = "";

  before(async () => {
    t = build();
    const publicId = await published(t, "Approved v1");
    await t.stories.update(ALICE, publicId, input("Pending v2"), 1);
    await t.approvals.submit(ALICE, publicId);
    pendingId = publicId;
    draftId = (await t.stories.create(ALICE, input("Draft only"))).hauntId;
    const app = express();
    app.use("/api/community", createCommunityRouter({ list: async () => [], get: async () => undefined } as never, t.stories));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("lists and plays the approved revision, never the pending one", async () => {
    const list = (await (await fetch(`${base}/api/community/stories`)).json()) as { stories: { title: string }[] };
    assert.deepEqual(list.stories.map((s) => s.title), ["Approved v1"]);
    const detail = (await (await fetch(`${base}/api/community/stories/${pendingId}`)).json()) as { card: { title: string }; episode: { title: string } };
    assert.equal(detail.card.title, "Approved v1");
    assert.equal(detail.episode.title, "Approved v1", "the episode played is the approved one");
    assert.doesNotMatch(JSON.stringify(detail), /Pending v2/);
  });

  it("answers a never-published draft as missing on the playback API", async () => {
    assert.equal((await fetch(`${base}/api/community/stories/${draftId}`)).status, 404);
  });
});

describe("unauthorized users cannot reach pending content", () => {
  it("another creator sees none of the owner's submissions, and cannot edit or submit the story", async () => {
    const t = build();
    const id = await published(t, "Approved v1");
    await t.stories.update(ALICE, id, input("Pending v2"), 1);
    await t.approvals.submit(ALICE, id);
    const others = await t.approvals.listForStory(id);
    assert.equal(others.filter((s) => s.submittedBy === BOB).length, 0);
    assert.equal(await t.stories.get(BOB, id), undefined, "another creator cannot read the story");
    await assert.rejects(t.stories.update(BOB, id, input("Hijack"), 2), (e: { code?: string }) => e.code === "not_found");
  });
});

describe("concurrency cannot expose an unapproved revision", () => {
  it("an approval that races with a further edit is refused, and the approved revision stays public", async () => {
    const t = build();
    const id = await published(t, "Approved v1");
    await t.stories.update(ALICE, id, input("Pending v2"), 1);
    const sub = await t.approvals.submit(ALICE, id);
    // A further edit lands between the approval's read and its transaction.
    t.dynamo.hooks.beforeTransact = () => {
      const row = t.dynamo.tables.get(STORIES)!.get(`${ALICE}|${id}`)!;
      t.dynamo.tables.get(STORIES)!.set(`${ALICE}|${id}`, { ...row, version: row.version + 1, story: input("Unreviewed v3") });
    };
    await assert.rejects(t.approvals.approve(ADMIN, sub.submissionId), (e: { code?: string }) => e.code === "stale");
    assert.deepEqual(await titlesOf(t), ["Approved v1"], "nothing unreviewed went public");
    assert.equal((await t.stories.findPublished(id))?.publicStory?.version, 1);
    assert.equal((await t.approvals.get(sub.submissionId))?.status, "PENDING_APPROVAL", "the review did not partly apply");
  });
});

describe("stories published before approval records existed", () => {
  it("remain public, with no approval record", async () => {
    const t = build();
    legacyPublished(t, "us_legacyaaaaaaaaaa", "Legacy title");
    assert.deepEqual(await titlesOf(t), ["Legacy title"]);
    assert.equal(publicRevisionOf((await t.stories.findPublished("us_legacyaaaaaaaaaa"))!)?.legacy, true);
  });

  it("keep their public revision when first edited, so the edit is not live unreviewed", async () => {
    const t = build();
    const legacyId = "us_legacybbbbbbbbbb";
    legacyPublished(t, legacyId, "Legacy title");
    await t.stories.update(ALICE, legacyId, input("Edited, unreviewed"), 4);
    assert.deepEqual(await titlesOf(t), ["Legacy title"], "still the old revision");
    assert.equal((await t.stories.findPublished(legacyId))?.publicStory?.story.title, "Legacy title");
  });
});

describe("direct API requests cannot set the public revision", () => {
  it("a publicStory field sent in an edit is ignored", async () => {
    const t = build();
    const story = await t.stories.create(ALICE, input("Draft"));
    const body = { ...input("Draft edited"), publicStory: { story: input("Forged"), version: 99, approvedAt: "x" } } as never;
    const next = await t.stories.update(ALICE, story.hauntId, body, 1);
    assert.equal(next.publicStory, undefined, "the record took no public revision from the request");
  });
});
