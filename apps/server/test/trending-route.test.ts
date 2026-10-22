import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createTrendingRouter, trendingLimit, MAX_TRENDING_LIMIT } from "../src/trending-route.ts";
import type { PlayRecord, PlaySource } from "../src/trending.ts";

const NOW = Date.UTC(2026, 9, 22, 12);
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const play = (storyId: string, n: number, hoursAgo: number): PlayRecord => ({ storyId, playId: `${storyId}-play-${n}`, playedAt: at(hoursAgo) });

function sourceOf(records: PlayRecord[], truncated = false): PlaySource {
  return { recentPlays: async () => ({ records, truncated }) };
}
const failing: PlaySource = {
  recentPlays: async () => {
    throw Object.assign(new Error("ProvisionedThroughputExceededException: table haunt-stats"), { name: "ProvisionedThroughputExceededException" });
  },
};

describe("the limit parameter", () => {
  it("accepts whole numbers from 1 to the maximum, and defaults when absent", () => {
    assert.equal(trendingLimit(undefined), 10);
    assert.equal(trendingLimit("1"), 1);
    assert.equal(trendingLimit(String(MAX_TRENDING_LIMIT)), MAX_TRENDING_LIMIT);
  });

  it("refuses zero, too many, negatives, decimals, words and arrays", () => {
    for (const bad of ["0", "21", "-1", "2.5", "ten", "", ["3"]]) assert.equal(trendingLimit(bad as never), undefined, String(bad));
  });
});

describe("GET /api/trending", () => {
  const eligibleIds = new Set(["fresh", "second", "third"]);
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  let current: PlaySource | undefined;
  let enabled = true;

  before(async () => {
    const app = express();
    app.use(
      "/api/trending",
      createTrendingRouter({
        get enabled() {
          return enabled;
        },
        get source() {
          return current;
        },
        isEligible: async (storyId) => eligibleIds.has(storyId),
        now: () => NOW,
      } as never),
    );
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const get = (query = "") => fetch(`${base}/api/trending${query}`);

  it("is off until HAUNT_TRENDING is on, and says so plainly", async () => {
    enabled = false;
    current = sourceOf([play("fresh", 1, 0)]);
    const res = await get();
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /isn't turned on yet/);
    enabled = true;
  });

  it("returns the ranked, eligible stories in order, with a bounded count", async () => {
    current = sourceOf([play("fresh", 1, 0), play("fresh", 2, 1), play("second", 1, 5), play("third", 1, 30)]);
    const body = (await (await get("?limit=2")).json()) as { stories: { storyId: string }[]; truncated: boolean; window: string };
    assert.deepEqual(body.stories.map((s) => s.storyId), ["fresh", "second"]);
    assert.equal(body.window, "7d");
    assert.equal(body.truncated, false);
  });

  it("drops stories that are not eligible (unpublished, rejected, deleted), and never shows them", async () => {
    current = sourceOf([play("removed", 1, 0), play("removed", 2, 0), play("fresh", 1, 2)]);
    const body = (await (await get()).json()) as { stories: { storyId: string }[] };
    assert.deepEqual(body.stories.map((s) => s.storyId), ["fresh"]);
  });

  it("returns an empty list, not an error, when nothing has been played in the window", async () => {
    current = sourceOf([]);
    const res = await get();
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { stories: unknown[] }).stories, []);
  });

  it("passes the truncation flag through, so a partial ranking is visible to the caller", async () => {
    current = sourceOf([play("fresh", 1, 0)], true);
    assert.equal(((await (await get()).json()) as { truncated: boolean }).truncated, true);
  });

  it("refuses an invalid limit before reading anything", async () => {
    current = failing;
    assert.equal((await get("?limit=999")).status, 400);
  });

  it("answers a DynamoDB failure with a plain message, without the table name or error code", async () => {
    current = failing;
    const res = await get();
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.doesNotMatch(text, /haunt-stats|ProvisionedThroughput|Exceeded/);
    assert.match(text, /Trending couldn't be loaded right now/);
  });
});
