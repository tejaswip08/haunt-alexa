import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { libraryUrlAfterPublish, publishAndOpenLibrary, publishNotice } from "../src/lib/admin-publish.ts";
import { fetchLibrary, toLibraryCards, type LibraryCard } from "../src/lib/library-data.ts";

const card = (storyId: string, title = "The Last Train"): LibraryCard => ({ storyId, title, summary: "s", creator: "Pen", minutes: 2 });

describe("Library data shared by /library and /tv", () => {
  it("keeps every story: nine published stories give nine cards, in the server's order", () => {
    const nine = Array.from({ length: 9 }, (_, i) => card(`st_${i}`, i % 2 ? "The Ring" : "The Last Train"));
    const cards = toLibraryCards(nine);
    assert.equal(cards.length, 9);
    assert.deepEqual(cards.map((c) => c.storyId), nine.map((c) => c.storyId));
  });

  it("shows each story id once, but keeps different stories with the same title", () => {
    const cards = toLibraryCards([card("a", "The Ring"), card("b", "The Ring"), card("a", "The Ring")]);
    assert.deepEqual(cards.map((c) => c.storyId), ["a", "b"]);
  });

  it("fetches fresh from list_library each time and reports tool errors", async () => {
    let calls = 0;
    const client = { callTool: async () => (calls++, { structuredContent: { episodes: [card("a"), card("b")] } }) };
    assert.equal((await fetchLibrary(client)).length, 2);
    await fetchLibrary(client);
    assert.equal(calls, 2, "no caching between calls");
    await assert.rejects(fetchLibrary({ callTool: async () => ({ isError: true }) }));
  });

  it("is the single source for both /library and /tv, with no six-story limit on the TV", () => {
    const tv = readFileSync(new URL("../src/pages/Tv.tsx", import.meta.url), "utf8");
    const library = readFileSync(new URL("../src/pages/Library.tsx", import.meta.url), "utf8");
    for (const source of [tv, library]) assert.match(source, /fetchLibrary\(/);
    assert.doesNotMatch(tv, /library\.slice\(/, "the TV must not trim the library");
  });
});

describe("Publishing from the admin page", () => {
  const body = { storyId: "st_abc", creator: "Pen", summary: "A keeper who never left." };

  it("navigates to /library with the story only after the server confirms", async () => {
    const visited: string[] = [];
    const outcome = await publishAndOpenLibrary(async () => ({ ok: true, action: "created" }), (u) => visited.push(u), body);
    assert.deepEqual(outcome, { ok: true, action: "created", url: "/library?published=st_abc&action=created" });
    assert.deepEqual(visited, ["/library?published=st_abc&action=created"]);
  });

  it("re-publishing the same story reports an update, not a new entry", async () => {
    const visited: string[] = [];
    await publishAndOpenLibrary(async () => ({ ok: true, action: "updated" }), (u) => visited.push(u), body);
    assert.deepEqual(visited, [libraryUrlAfterPublish("st_abc", "updated")]);
  });

  it("stays put with the error when publishing fails", async () => {
    const visited: string[] = [];
    const outcome = await publishAndOpenLibrary(
      async () => {
        throw new Error("That admin token isn't right.");
      },
      (u) => visited.push(u),
      body,
    );
    assert.deepEqual(outcome, { ok: false, error: "That admin token isn't right." });
    assert.deepEqual(visited, []);
  });

  it("passes on a duplicate-content refusal so the admin can choose, without navigating", async () => {
    const visited: string[] = [];
    const refusal = Object.assign(new Error("Same narration as st_old."), { data: { duplicateOf: "st_old" } });
    const outcome = await publishAndOpenLibrary(
      async () => {
        throw refusal;
      },
      (u) => visited.push(u),
      body,
    );
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.duplicateOf, "st_old");
    assert.deepEqual(visited, []);
  });

  it("doesn't navigate when the server's reply doesn't confirm a publish", async () => {
    const visited: string[] = [];
    const outcome = await publishAndOpenLibrary(async () => ({}), (u) => visited.push(u), body);
    assert.equal(outcome.ok, false);
    assert.deepEqual(visited, []);
  });

  it("the library announces the result it was sent", () => {
    assert.deepEqual(publishNotice("?published=st_abc&action=created"), { storyId: "st_abc", message: "Story published successfully." });
    assert.equal(publishNotice("?published=st_abc&action=updated")?.message, "Story updated successfully.");
    assert.equal(publishNotice(""), null);
  });
});
