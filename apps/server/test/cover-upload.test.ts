import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { coverKey, coverPath, coverSaveProblem, isValidCoverKey, keyBelongsTo, keyFromCoverPath, MAX_COVER_BYTES, type CoverStorage } from "../src/covers.ts";
import { StoryInputSchema, type UserStoryStore } from "../src/user-stories.ts";
import { createMyStoriesRouter } from "../src/user-stories-route.ts";

// Cover uploads, against a fake bucket and a stub story store. No AWS calls.

const ALICE = "8f1c2d3e-0000-4000-8000-00000000a11c";
const BOB = "8f1c2d3e-0000-4000-8000-00000000b0b0";
const STORY = "us_abcdefghijklmnop";
const OTHER_STORY = "us_qrstuvwxyz123456";

function fakeBucket() {
  const objects = new Set<string>();
  const storage: CoverStorage & { objects: Set<string>; presigned: string[] } = {
    objects,
    presigned: [],
    async presignUpload(key, contentType) {
      storage.presigned.push(key);
      return { url: "https://bucket.example.test/", fields: { key, "Content-Type": contentType, policy: "signed" } };
    },
    async exists(key) {
      return objects.has(key);
    },
    async read(key) {
      return objects.has(key) ? Readable.from([Buffer.from("png-bytes")]) : undefined;
    },
  };
  return storage;
}

/** A stub story store: stories keyed by owner, so one owner can't see another's. */
function stubStore(getStories: () => Record<string, string[]>) {
  const owned = (userId: string, hauntId: string) => (getStories()[userId] ?? []).includes(hauntId);
  return {
    get: async (userId: string, hauntId: string) =>
      owned(userId, hauntId) ? { hauntId, version: 1, status: "draft", story: { coverUrl: "" } } : undefined,
    update: async (_userId: string, hauntId: string, input: { coverUrl: string }) => ({ hauntId, version: 2, status: "draft", story: input }),
  } as unknown as UserStoryStore;
}

describe("cover keys and paths", () => {
  it("keeps every key under the owner's story, with a fresh name each time", () => {
    const first = coverKey(ALICE, STORY, "image/png");
    const second = coverKey(ALICE, STORY, "image/png");
    assert.notEqual(first, second);
    assert.match(first, new RegExp(`^covers/${ALICE}/${STORY}/[0-9a-f-]{36}\\.png$`));
    assert.ok(isValidCoverKey(first));
    assert.ok(keyBelongsTo(first, ALICE, STORY));
    assert.equal(keyBelongsTo(first, BOB, STORY), false);
    assert.equal(keyBelongsTo(first, ALICE, OTHER_STORY), false);
  });

  it("round-trips a stored path to its key, and refuses anything else", () => {
    const key = coverKey(ALICE, STORY, "image/webp");
    assert.equal(keyFromCoverPath(coverPath(key)), key);
    assert.equal(keyFromCoverPath(`/api/covers/covers/${ALICE}/${STORY}/../../etc.png`), null);
    assert.equal(keyFromCoverPath("/api/covers/covers/x/y/z.gif"), null);
    assert.equal(isValidCoverKey(`covers/${ALICE}/${STORY}/not-a-uuid.jpg`), false);
  });
});

describe("the cover field on story saves", () => {
  it("accepts an https link, an upload path, or nothing", () => {
    const base = { title: "T", author: "A", segments: [{ sceneIndex: 0, narration: "x", ending: true }] };
    const key = coverKey(ALICE, STORY, "image/jpeg");
    for (const coverUrl of ["", "https://example.com/c.jpg", coverPath(key)]) {
      assert.ok(StoryInputSchema.safeParse({ ...base, coverUrl }).success, coverUrl);
    }
    for (const coverUrl of ["http://example.com/c.jpg", "/api/covers/../secret", "javascript:alert(1)"]) {
      assert.equal(StoryInputSchema.safeParse({ ...base, coverUrl }).success, false, coverUrl);
    }
  });

  it("refuses an upload that belongs to another story, or that was never uploaded", async () => {
    const bucket = fakeBucket();
    const mine = coverKey(ALICE, STORY, "image/jpeg");
    assert.match((await coverSaveProblem(bucket, ALICE, STORY, coverPath(mine))) ?? "", /wasn't uploaded/);
    bucket.objects.add(mine);
    assert.equal(await coverSaveProblem(bucket, ALICE, STORY, coverPath(mine)), null);
    assert.match((await coverSaveProblem(bucket, BOB, STORY, coverPath(mine))) ?? "", /isn't one of this story/);
    assert.match((await coverSaveProblem(undefined, ALICE, STORY, coverPath(mine))) ?? "", /aren't set up/);
  });

  it("leaves https links and empty covers alone", async () => {
    assert.equal(await coverSaveProblem(undefined, ALICE, STORY, "https://example.com/c.jpg"), null);
    assert.equal(await coverSaveProblem(undefined, ALICE, STORY, ""), null);
  });
});

describe("the HTTP routes", () => {
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  const bucket = fakeBucket();
  let stories: Record<string, string[]> = {};

  before(async () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((req, res, next) => {
      const sub = req.headers["x-test-user"];
      if (typeof sub === "string") res.locals.user = { sub };
      next();
    });
    app.use("/api/me/user-stories", createMyStoriesRouter(stubStore(() => stories), { hit: () => ({ ok: true }) } as never, bucket));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  // The routes read the stories at request time, so each test sets who owns what.
  const as = (sub: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, redirect: "manual", headers: { "content-type": "application/json", "x-test-user": sub, ...(init.headers as Record<string, string>) } });

  it("issues a presigned upload for the owner's story only", async () => {
    stories = { [ALICE]: [STORY] };
    const body = JSON.stringify({ contentType: "image/png", size: 1024 });
    const ok = await as(ALICE, `/api/me/user-stories/${STORY}/cover`, { method: "POST", body });
    assert.equal(ok.status, 200);
    const data = (await ok.json()) as { url: string; fields: Record<string, string>; coverUrl: string };
    assert.match(data.coverUrl, new RegExp(`^/api/covers/covers/${ALICE}/${STORY}/`));
    assert.ok(data.fields.key.startsWith(`covers/${ALICE}/${STORY}/`));

    const theirs = await as(BOB, `/api/me/user-stories/${STORY}/cover`, { method: "POST", body });
    assert.equal(theirs.status, 404, "another owner gets the same answer as a missing story");
  });

  it("refuses unsupported types and oversize files before any upload is signed", async () => {
    stories = { [ALICE]: [STORY] };
    const gif = await as(ALICE, `/api/me/user-stories/${STORY}/cover`, { method: "POST", body: JSON.stringify({ contentType: "image/gif", size: 1 }) });
    assert.equal(gif.status, 422);
    const big = await as(ALICE, `/api/me/user-stories/${STORY}/cover`, { method: "POST", body: JSON.stringify({ contentType: "image/jpeg", size: MAX_COVER_BYTES + 1 }) });
    assert.equal(big.status, 422);
    const empty = await as(ALICE, `/api/me/user-stories/${STORY}/cover`, { method: "POST", body: JSON.stringify({ contentType: "image/jpeg", size: 0 }) });
    assert.equal(empty.status, 422);
  });

  it("saves an uploaded cover on the story, and refuses one that isn't this owner's", async () => {
    stories = { [ALICE]: [STORY] };
    const key = coverKey(ALICE, STORY, "image/jpeg");
    bucket.objects.add(key);
    const story = { title: "The Last Knock", author: "Haunt Sample", coverUrl: coverPath(key), segments: [{ sceneIndex: 0, narration: "x", ending: true }], expectedVersion: 1 };
    const saved = await as(ALICE, `/api/me/user-stories/${STORY}`, { method: "PUT", body: JSON.stringify(story) });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { story: { story: { coverUrl: string } } }).story.story.coverUrl, coverPath(key));

    const stolen = await as(BOB, `/api/me/user-stories/${STORY}`, { method: "PUT", body: JSON.stringify(story) });
    assert.equal(stolen.status, 404);

    const wrongStory = await as(ALICE, `/api/me/user-stories/${OTHER_STORY}`, { method: "PUT", body: JSON.stringify(story) });
    assert.equal(wrongStory.status, 404);

    stories = { [ALICE]: [STORY, OTHER_STORY] };
    const elsewhere = await as(ALICE, `/api/me/user-stories/${OTHER_STORY}`, { method: "PUT", body: JSON.stringify(story) });
    assert.equal(elsewhere.status, 422, "a cover from one story can't be put on another");
  });

});
