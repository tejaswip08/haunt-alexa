import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMockProvider, createStoryEngine, MemoryStore } from "@firetales/core";
import type { Library, LibraryEntry } from "../src/library.ts";
import { migrate } from "../src/migrate.ts";

function memoryLibrary(entries: LibraryEntry[]): Library {
  return {
    list: async () => entries,
    get: async (id) => entries.find((e) => e.episode.storyId === id),
    put: async () => {},
    remove: async () => {},
  };
}

describe("Local → DynamoDB migration", () => {
  it("dry run reports what would be copied and writes nothing", async () => {
    const stories = new MemoryStore();
    await createStoryEngine({ provider: createMockProvider(), store: stories }).start({ premise: "One" });
    let writes = 0;
    const report = await migrate(
      { stories, library: memoryLibrary([]) },
      { putStoryIfAbsent: async () => (writes++, true), putEntryIfAbsent: async () => (writes++, true) },
      { dryRun: true },
    );
    assert.equal(report.stories.found, 1);
    assert.equal(writes, 0);
  });

  it("copies once, and a second run leaves existing records alone", async () => {
    const stories = new MemoryStore();
    const engine = createStoryEngine({ provider: createMockProvider(), store: stories });
    await engine.start({ premise: "One" });
    await engine.start({ premise: "Two" });
    const entry = { episode: { storyId: "st_1" }, creator: "Pen", summary: "", publishedAt: "2026-10-17" } as unknown as LibraryEntry;
    const target = new Set<string>();
    const sink = {
      putStoryIfAbsent: async (s: { id: string }) => (target.has(s.id) ? false : (target.add(s.id), true)),
      putEntryIfAbsent: async (e: LibraryEntry) => (target.has(`lib:${e.episode.storyId}`) ? false : (target.add(`lib:${e.episode.storyId}`), true)),
    };
    const first = await migrate({ stories, library: memoryLibrary([entry]) }, sink, { dryRun: false });
    assert.deepEqual(first.stories, { found: 2, copied: 2, alreadyThere: 0 });
    assert.deepEqual(first.library, { found: 1, copied: 1, alreadyThere: 0 });
    const second = await migrate({ stories, library: memoryLibrary([entry]) }, sink, { dryRun: false });
    assert.deepEqual(second.stories, { found: 2, copied: 0, alreadyThere: 2 });
    assert.equal((await stories.list()).length, 2, "source untouched");
  });
});
