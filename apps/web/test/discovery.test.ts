import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchFeatured, fetchTrending, knownStories } from "../src/lib/discovery.ts";

// A fake fetch that answers with a fixed status and JSON body. No network.
const answer = (status: number, body: unknown = {}) => async () => new Response(JSON.stringify(body), { status });

describe("the web Trending rail's data", () => {
  it("keeps the ranked order and the play counts the server sends", async () => {
    const result = await fetchTrending(answer(200, { stories: [{ storyId: "b", score: 2, plays: 3 }, { storyId: "a", score: 1, plays: 1 }] }));
    assert.deepEqual(result, { kind: "ok", items: [{ storyId: "b", plays: 3 }, { storyId: "a", plays: 1 }] });
  });

  it("treats a 503 or 404 as not available here, so the rail is left out rather than shown as an error", async () => {
    assert.deepEqual(await fetchTrending(answer(503, { error: "off" })), { kind: "unavailable" });
    assert.deepEqual(await fetchTrending(answer(404)), { kind: "unavailable" });
  });

  it("reports any other failure as an error the rail can say", async () => {
    assert.deepEqual(await fetchTrending(answer(500)), { kind: "error" });
    assert.deepEqual(
      await fetchTrending(async () => {
        throw new TypeError("network down");
      }),
      { kind: "error" },
    );
  });
});

describe("the web Featured Tonight rail's data", () => {
  it("returns the active features, and an empty list when nothing is featured", async () => {
    const feature = { storyId: "a", startsAt: "2026-10-22T18:00:00.000Z", endsAt: "2026-10-23T18:00:00.000Z" };
    assert.deepEqual(await fetchFeatured(answer(200, { features: [feature], fallback: false })), { kind: "ok", items: [feature] });
    assert.deepEqual(await fetchFeatured(answer(200, { features: [], fallback: true })), { kind: "ok", items: [] });
  });

  it("treats a 503 or 404 as not available here", async () => {
    assert.deepEqual(await fetchFeatured(answer(503)), { kind: "unavailable" });
    assert.deepEqual(await fetchFeatured(answer(404)), { kind: "unavailable" });
  });
});

describe("matching ranked ids to known stories", () => {
  it("keeps the order and drops any id with no known story, so nothing is shown without a title", () => {
    const known = new Map([
      ["a", { title: "A" }],
      ["c", { title: "C" }],
    ]);
    assert.deepEqual(knownStories(["c", "missing", "a"], known), [{ title: "C" }, { title: "A" }]);
  });
});
