import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import express from "express";
import { coverPath, type CoverStorage } from "../src/covers.ts";
import { isNamedAdmin } from "../src/story-review-route.ts";
import { createCoverRouter } from "../src/user-stories-route.ts";
import type { SubmissionRecord, SubmissionStatus } from "../src/story-approvals.ts";

// Cover reads, against a fake bucket and stub stores. Each story is in one state; each request is checked against it.

const OWNER = "8f1c2d3e-0000-4000-8000-00000000a11c";
const OTHER = "8f1c2d3e-0000-4000-8000-00000000b0b0";
const ADMIN = "8f1c2d3e-0000-4000-8000-0000000ad111";
const LISTENER = "8f1c2d3e-0000-4000-8000-00000000c0c0";
const HAUNT = "us_abcdefghijklmnop";

interface StoryState {
  status: "draft" | "published";
  publishedKey?: "published";
  version: number;
  coverUrl: string;
  submission?: SubmissionStatus;
}

/** Builds one request-scoped app. The state of the story under test is passed in, so each case is explicit. */
async function serve(state: StoryState | undefined, storageHas: boolean, viewer?: { sub: string; admin?: boolean }) {
  // One fixed key, so a story's cover path and the stored object agree across the calls in one test.
  const key = `covers/${OWNER}/${HAUNT}/0a1b2c3d-0000-4000-8000-000000000001.png`;
  const bucket = new Set<string>(storageHas ? [key] : []);
  const storage: CoverStorage = {
    async presignUpload() {
      return { url: "https://bucket.example.test/", fields: {} };
    },
    async exists(k) {
      return bucket.has(k);
    },
    async read(k) {
      return bucket.has(k) ? Readable.from([Buffer.from("png-bytes")]) : undefined;
    },
  };
  const record = state
    ? { hauntId: HAUNT, userId: OWNER, status: state.status, publishedKey: state.publishedKey, version: state.version, story: { coverUrl: state.coverUrl } }
    : undefined;
  const stories = { get: async (owner: string, hauntId: string) => (owner === OWNER && hauntId === HAUNT ? record : undefined) } as never;
  const submission: SubmissionRecord | undefined = state?.submission
    ? { submissionId: `${HAUNT}#${state.version}`, storyId: HAUNT, submittedBy: OWNER, status: state.submission, submittedAt: "", version: state.version, createdAt: "", updatedAt: "" }
    : undefined;
  const approvals = { get: async (id: string) => (submission && id === submission.submissionId ? submission : undefined) } as never;
  const profiles = { get: async (sub: string) => ({ role: sub === ADMIN ? "ADMIN" : "LISTENER" }) } as never;

  const app = express();
  app.use((req, res, next) => {
    const sub = req.headers["x-test-user"];
    if (typeof sub === "string") res.locals.user = { sub, admin: req.headers["x-test-admin-group"] === "yes" };
    next();
  });
  app.use(
    "/api/covers",
    createCoverRouter({
      storage,
      stories,
      approvals,
      isAdmin: (user) => isNamedAdmin(user, profiles, false),
    }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers: Record<string, string> = viewer ? { "x-test-user": viewer.sub, ...(viewer.admin ? { "x-test-admin-group": "yes" } : {}) } : {};
  const res = await fetch(`${base}${coverPath(key)}`, { headers, redirect: "manual" });
  const body = await res.text();
  await new Promise((resolve) => server.close(resolve));
  return { res, body, key };
}

const publishedAndApproved: StoryState = { status: "published", publishedKey: "published", version: 3, coverUrl: "", submission: "APPROVED" };

describe("cover reads: unauthenticated", () => {
  it("serves a current cover of an approved, published story to anyone", async () => {
    const probe = await serve({ ...publishedAndApproved, coverUrl: "" }, true);
    const state = { ...publishedAndApproved, coverUrl: coverPath(probe.key) };
    const { res, body } = await serve(state, true);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(body, "png-bytes");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(res.headers.get("location"), null, "no signed link is handed out");
  });

  it("refuses a draft's cover to anyone who is not the owner", async () => {
    const probe = await serve(undefined, true);
    const { res } = await serve({ status: "draft", version: 1, coverUrl: coverPath(probe.key) }, true);
    assert.equal(res.status, 404);
  });

  it("refuses a pending story's cover to anyone, even when it is the current cover", async () => {
    const probe = await serve(undefined, true);
    const state: StoryState = { status: "draft", version: 2, coverUrl: coverPath(probe.key), submission: "PENDING_APPROVAL" };
    assert.equal((await serve(state, true)).res.status, 404);
  });

  it("refuses a rejected story's cover to anyone", async () => {
    const probe = await serve(undefined, true);
    const state: StoryState = { status: "draft", version: 2, coverUrl: coverPath(probe.key), submission: "REJECTED" };
    assert.equal((await serve(state, true)).res.status, 404);
  });

  it("refuses a withdrawn story's cover to anyone", async () => {
    const probe = await serve(undefined, true);
    const state: StoryState = { status: "draft", version: 2, coverUrl: coverPath(probe.key), submission: "WITHDRAWN" };
    assert.equal((await serve(state, true)).res.status, 404);
  });

  it("refuses an approved story's cover once the story has been replaced by another cover", async () => {
    const probe = await serve(undefined, true);
    const state: StoryState = { ...publishedAndApproved, coverUrl: "https://example.com/other.jpg" };
    assert.equal((await serve(state, true)).res.status, 404);
    assert.ok(probe.key);
  });

  it("answers a cover that does not exist, and a story that does not exist, the same way", async () => {
    assert.equal((await serve(undefined, false)).res.status, 404);
    const probe = await serve(undefined, true);
    assert.equal((await serve({ ...publishedAndApproved, coverUrl: coverPath(probe.key) }, false)).res.status, 404);
  });
});

describe("cover reads: signed in", () => {
  it("lets the owner read the cover of their own draft", async () => {
    const probe = await serve(undefined, true);
    const { res, body } = await serve({ status: "draft", version: 1, coverUrl: coverPath(probe.key) }, true, { sub: OWNER });
    assert.equal(res.status, 200);
    assert.equal(body, "png-bytes");
  });

  it("lets the owner read their own pending and rejected covers", async () => {
    const probe = await serve(undefined, true);
    for (const submission of ["PENDING_APPROVAL", "REJECTED"] as const) {
      const state: StoryState = { status: "draft", version: 2, coverUrl: coverPath(probe.key), submission };
      assert.equal((await serve(state, true, { sub: OWNER })).res.status, 200, submission);
    }
  });

  it("lets a named admin read a pending story's cover for review", async () => {
    const probe = await serve(undefined, true);
    const state: StoryState = { status: "draft", version: 2, coverUrl: coverPath(probe.key), submission: "PENDING_APPROVAL" };
    assert.equal((await serve(state, true, { sub: ADMIN })).res.status, 200);
  });

  it("does not let an admin token with no named user read a private cover", async () => {
    const probe = await serve(undefined, true);
    const state: StoryState = { status: "draft", version: 2, coverUrl: coverPath(probe.key), submission: "PENDING_APPROVAL" };
    assert.equal((await serve(state, true)).res.status, 404);
  });

  it("does not let a listener or the group flag alone read a private cover", async () => {
    const probe = await serve(undefined, true);
    const state: StoryState = { status: "draft", version: 2, coverUrl: coverPath(probe.key), submission: "PENDING_APPROVAL" };
    assert.equal((await serve(state, true, { sub: LISTENER })).res.status, 404);
    assert.equal((await serve(state, true, { sub: LISTENER, admin: true })).res.status, 404, "the legacy group is off here");
  });

  it("lets any signed-in user read an approved public cover, but not another creator's draft", async () => {
    const probe = await serve(undefined, true);
    const pub = { ...publishedAndApproved, coverUrl: coverPath(probe.key) };
    assert.equal((await serve(pub, true, { sub: OTHER })).res.status, 200);
    const draft: StoryState = { status: "draft", version: 1, coverUrl: coverPath(probe.key) };
    assert.equal((await serve(draft, true, { sub: OTHER })).res.status, 404);
  });
});
