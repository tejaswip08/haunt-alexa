import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";

// The real GET /api/me/library route, with a fake DynamoDB (the user's library item) and a fake story library. Offline.
const { createMyLibraryRouter } = await import("../src/me-library.ts");
const { ViewingStore } = await import("../src/viewing.ts");
const { createRateLimiter } = await import("../src/rate-limit.ts");

const USER = "user-1";
const segments = [
  { narration: "a", mood: "calm", visualPrompt: "v", sceneIndex: 0, soundCues: [] },
  { narration: "b", mood: "calm", visualPrompt: "v", sceneIndex: 1, soundCues: [], choices: { prompt: "?", options: [{ label: "x", next: 2 }, { label: "y", next: 4 }] } },
  { narration: "c", mood: "calm", visualPrompt: "v", sceneIndex: 2, soundCues: [] },
  { narration: "d", mood: "calm", visualPrompt: "v", sceneIndex: 3, soundCues: [], ending: true },
  { narration: "e", mood: "calm", visualPrompt: "v", sceneIndex: 4, soundCues: [], ending: true },
];
const entry = (storyId: string) => ({
  episode: { storyId, title: storyId, estimatedMinutes: 3, language: "en", premise: "p", script: "s", segments, wordCount: 1 },
  creator: "Haunt Team",
  summary: `${storyId} summary`,
  publishedAt: "2026-10-01T00:00:00.000Z",
});

/** What the user's library item holds, in the shape ViewingStore reads (progress, likes, modes). */
let libraryItem: Record<string, unknown> = {};
const fakeDb = {
  send: async (command: { input: { Key: { userId: string } } }) => ({ Item: command.input.Key.userId === `${USER}#library` ? libraryItem : undefined }),
} as unknown as ConstructorParameters<typeof ViewingStore>[0];

const library = {
  get: async (storyId: string) => entry(storyId),
} as unknown as Parameters<typeof createMyLibraryRouter>[1];

let base = "";
let server: ReturnType<express.Express["listen"]>;
before(async () => {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.user = { sub: USER, admin: false };
    next();
  });
  const viewing = new ViewingStore(fakeDb);
  app.use("/api/me/library", createMyLibraryRouter(viewing, library, undefined, createRateLimiter([{ windowMs: 60_000, max: 1000 }])));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function continueWatching(): Promise<Record<string, Record<string, unknown>>> {
  const res = await fetch(`${base}/api/me/library`);
  const body = (await res.json()) as { continueWatching: Record<string, unknown>[] };
  return Object.fromEntries(body.continueWatching.map((w) => [w.storyId as string, w]));
}

describe("Continue Watching entries from saved progress", () => {
  it("keeps a choice-based run's mode, segment, and branch history", async () => {
    libraryItem = { progress: { "choice-story": { partIndex: 1, positionMs: 0, completed: false, lastPlayedAt: "2026-10-20T10:00:00.000Z", mode: "choices", segment: 1, history: [0, 1] } } };
    const w = (await continueWatching())["choice-story"]!;
    assert.equal(w.mode, "choices");
    assert.equal(w.segment, 1);
    assert.deepEqual(w.history, [0, 1]);
    assert.equal(w.partIndex, 1);
  });

  it("does not give older progress the remembered play mode", async () => {
    // Regression: `modes` holds the play mode the listener picked for this story; it must not stand in for a record's own mode.
    libraryItem = {
      progress: { "older-story": { partIndex: 2, positionMs: 0, completed: false, lastPlayedAt: "2026-10-19T10:00:00.000Z" } },
      modes: { "older-story": "choices" },
    };
    const w = (await continueWatching())["older-story"]!;
    assert.equal(w.mode, null);
    assert.equal(w.history, null);
    assert.equal(w.partIndex, 2);
  });

  it("keeps a linear (listen) run's saved part and position", async () => {
    libraryItem = { progress: { "linear-story": { partIndex: 2, positionMs: 41_000, completed: false, lastPlayedAt: "2026-10-18T10:00:00.000Z", mode: "listen" } } };
    const w = (await continueWatching())["linear-story"]!;
    assert.equal(w.mode, "listen");
    assert.equal(w.partIndex, 2);
    assert.equal(w.positionMs, 41_000);
  });

  it("leaves completed stories out of Continue Watching", async () => {
    libraryItem = {
      progress: {
        "finished-story": { partIndex: 3, positionMs: 0, completed: true, completedAt: "2026-10-17T10:00:00.000Z", lastPlayedAt: "2026-10-17T10:00:00.000Z", mode: "choices", segment: 3, history: [0, 1, 2, 3] },
        "open-story": { partIndex: 1, positionMs: 0, completed: false, lastPlayedAt: "2026-10-16T10:00:00.000Z", mode: "choices", segment: 1, history: [0, 1] },
      },
    };
    const cards = await continueWatching();
    assert.equal("finished-story" in cards, false);
    assert.equal("open-story" in cards, true);
  });
});
