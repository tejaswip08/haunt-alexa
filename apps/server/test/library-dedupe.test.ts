import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentHash, findSimilar, uniqueEntries, type LibraryEntry } from "../src/library.ts";

const entry = (storyId: string, title: string, premise: string, script: string, publishedAt = "2026-10-17T10:00:00Z", updatedAt?: string) =>
  ({ episode: { storyId, title, premise, script, segments: [] }, creator: "Pen", summary: "s", publishedAt, updatedAt }) as unknown as LibraryEntry;

describe("Library duplicate detection", () => {
  it("fingerprints narration ignoring whitespace and case", () => {
    assert.equal(contentHash({ script: "The  door\nOPENS." }), contentHash({ script: "the door opens." }));
    assert.notEqual(contentHash({ script: "The door opens." }), contentHash({ script: "The door closes." }));
  });

  it("names the reason a different story looks alike, and never flags the story itself", () => {
    const entries = [
      entry("a", "The Ring", "A night shift", "one"),
      entry("b", "The Last Train", "An empty station", "two"),
      entry("c", "Other", "Something else", "same words"),
    ];
    const candidate = entry("x", "The Ring!", "An empty station", "Same  words").episode;
    assert.deepEqual(
      findSimilar(candidate, entries).map((s) => `${s.storyId}:${s.reason}`),
      ["a:same title", "b:same premise", "c:same content"],
    );
    assert.deepEqual(findSimilar(entries[0]!.episode, entries), []);
  });

  it("keeps one entry per story id, preferring the newest update", () => {
    const list = uniqueEntries([
      entry("a", "T", "P", "x", "2026-10-17T10:00:00Z"),
      entry("a", "T", "P", "x", "2026-10-17T10:00:00Z", "2026-10-17T12:00:00Z"),
      entry("b", "T", "P", "y", "2026-10-17T11:00:00Z"),
    ]);
    assert.deepEqual(list.map((e) => e.episode.storyId), ["b", "a"]);
    assert.equal(list[1]!.updatedAt, "2026-10-17T12:00:00Z");
  });
});
