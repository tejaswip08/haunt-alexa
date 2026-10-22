import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  dynamoPlaySource,
  playIdFromKey,
  isUsablePlay,
  MAX_EVENTS_PER_DAY,
  playWeight,
  rankTrending,
  trendDayOf,
  trendingStories,
  TREND_HALF_LIFE_HOURS,
  TREND_INDEX,
  windowDays,
  type PlayRecord,
} from "../src/trending.ts";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const play = (storyId: string, playId: string, hoursAgo: number): PlayRecord => ({ storyId, playId, playedAt: at(hoursAgo) });

describe("play weight", () => {
  it("is 1 for a play that is happening now, half after one half-life, and never more than 1", () => {
    assert.equal(playWeight(0), 1);
    assert.ok(Math.abs(playWeight(TREND_HALF_LIFE_HOURS * 3_600_000) - 0.5) < 1e-12);
    assert.equal(playWeight(-5_000), 1, "a clock-skewed future time counts as now, not more");
  });
});

describe("ranking by recent plays", () => {
  it("ranks a single play from now above three plays from six days ago", () => {
    const ranked = rankTrending([play("old", "old-play-1", 144), play("old", "old-play-2", 144), play("old", "old-play-3", 144), play("fresh", "new-play-1", 0)], {
      now: NOW,
      limit: 10,
    });
    assert.deepEqual(ranked.map((r) => r.storyId), ["fresh", "old"]);
  });

  it("counts a repeated (storyId, playId) once, however many copies are read", () => {
    const ranked = rankTrending([play("a", "same-play-1", 1), play("a", "same-play-1", 1), play("a", "same-play-1", 0)], { now: NOW, limit: 5 });
    assert.equal(ranked[0]!.plays, 1);
  });

  it("ignores plays with an invalid playId, storyId or time", () => {
    const ranked = rankTrending(
      [
        play("a", "short", 0),
        { storyId: "a", playId: "bad id with spaces", playedAt: at(0) },
        { storyId: "has space", playId: "valid-play-1", playedAt: at(0) },
        { storyId: "a", playId: "valid-play-2", playedAt: "not a date" },
        play("b", "valid-play-3", 0),
      ],
      { now: NOW, limit: 5 },
    );
    assert.deepEqual(ranked.map((r) => r.storyId), ["b"]);
    assert.equal(isUsablePlay(play("a", "short", 0)), false);
  });

  it("ignores plays older than the window and plays in the future", () => {
    const ranked = rankTrending([play("old", "p-old-000", 24 * 8), play("future", "p-future-1", -2), play("in", "p-in-0001", 1)], {
      now: NOW,
      limit: 5,
    });
    assert.deepEqual(ranked.map((r) => r.storyId), ["in"]);
  });

  it("breaks ties by plays, then by storyId, so the order is always the same", () => {
    const sameTime = [play("zeta", "zeta-play-1", 2), play("alpha", "alpha-play-1", 2)];
    assert.deepEqual(rankTrending(sameTime, { now: NOW, limit: 5 }).map((r) => r.storyId), ["alpha", "zeta"]);
    const moreWithSameScore = [play("two", "two-play-1", 0), play("two", "two-play-2", 0), play("one", "one-play-1", 0)];
    assert.equal(rankTrending(moreWithSameScore, { now: NOW, limit: 5 })[0]!.storyId, "two");
    const reversed = [...sameTime].reverse();
    assert.deepEqual(rankTrending(reversed, { now: NOW, limit: 5 }), rankTrending(sameTime, { now: NOW, limit: 5 }), "input order does not matter");
  });

  it("returns an empty list when there are no plays, and respects the limit", () => {
    assert.deepEqual(rankTrending([], { now: NOW, limit: 5 }), []);
    const many = ["a", "b", "c", "d"].map((id, i) => play(id, `${id}-play-01`, i));
    assert.equal(rankTrending(many, { now: NOW, limit: 2 }).length, 2);
    assert.equal(rankTrending(many, { now: NOW, limit: 0 }).length, 0);
  });
});

describe("the day partitions", () => {
  it("gives the UTC day of a play, and seven days ending today, oldest first", () => {
    assert.equal(trendDayOf(at(0)), "2026-10-22");
    const days = windowDays(NOW);
    assert.equal(days.length, 7);
    assert.equal(days[6], "2026-10-22");
    assert.equal(days[0], "2026-10-16");
  });
});

describe("reading recent plays from DynamoDB", () => {
  type Page = { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
  /** A client that answers Query commands from a script, keyed by day, and records every command it was sent. */
  function fakeClient(pagesByDay: Record<string, Page[] | Error>) {
    const sent: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        sent.push(command);
        const input = (command as { input: { ExpressionAttributeValues: Record<string, string> } }).input;
        const script = pagesByDay[input.ExpressionAttributeValues[":day"]!];
        if (script instanceof Error) throw script;
        const next = script?.shift();
        return next ?? { Items: [] };
      },
    };
    return { client, sent };
  }
  // The stored shape: the key carries the playId; there is no playId attribute.
  const item = (storyId: string, playId: string, playedAt: string) => ({ id: `play#${storyId}#${playId}`, storyId, playedAt, trendDay: playedAt.slice(0, 10) });

  it("queries the day index, never scans, and reads each day of the window", async () => {
    const { client, sent } = fakeClient({ "2026-10-22": [{ Items: [item("a", "a-play-0001", at(1))] }] });
    const result = await dynamoPlaySource(client as never, "haunt-stats").recentPlays(NOW);
    assert.equal(result.records.length, 1);
    assert.equal(result.truncated, false);
    assert.equal(sent.length, 7, "one bounded query per day in the window");
    for (const command of sent) {
      assert.ok(command instanceof QueryCommand, "only queries");
      assert.ok(!(command instanceof ScanCommand));
      assert.equal((command as QueryCommand).input.IndexName, TREND_INDEX);
    }
  });

  it("follows pages until the last one", async () => {
    const { client } = fakeClient({
      "2026-10-22": [{ Items: [item("a", "a-play-0001", at(1))], LastEvaluatedKey: { id: "x" } }, { Items: [item("b", "b-play-0001", at(2))] }],
    });
    const result = await dynamoPlaySource(client as never, "haunt-stats").recentPlays(NOW);
    assert.deepEqual(result.records.map((r) => r.storyId).sort(), ["a", "b"]);
  });

  it("stops at the per-day cap and says the read was truncated, rather than pretending to be complete", async () => {
    const full = Array.from({ length: 500 }, (_, i) => item("a", `a-play-${String(i).padStart(4, "0")}`, at(1)));
    const pages: Page[] = [];
    for (let i = 0; i < MAX_EVENTS_PER_DAY / 500 + 2; i++) pages.push({ Items: full, LastEvaluatedKey: { id: `k${i}` } });
    const { client } = fakeClient({ "2026-10-22": pages });
    const result = await dynamoPlaySource(client as never, "haunt-stats").recentPlays(NOW);
    assert.equal(result.truncated, true);
    assert.ok(result.records.length <= MAX_EVENTS_PER_DAY);
  });

  it("lets a DynamoDB error through rather than returning an empty ranking", async () => {
    const error = Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    const { client } = fakeClient({ "2026-10-20": error });
    await assert.rejects(dynamoPlaySource(client as never, "haunt-stats").recentPlays(NOW), /throttled/);
  });

  it("the trending entry point reports truncation alongside the ranking", async () => {
    const source = { recentPlays: async () => ({ records: [play("a", "a-play-0001", 1)], truncated: true }) };
    const result = await trendingStories(source, { now: NOW, limit: 5 });
    assert.equal(result.truncated, true);
    assert.equal(result.stories[0]!.storyId, "a");
  });

  it("an empty table gives an empty ranking, not an error", async () => {
    const { client } = fakeClient({});
    const result = await trendingStories(dynamoPlaySource(client as never, "haunt-stats"), { now: NOW, limit: 5 });
    assert.deepEqual(result, { stories: [], truncated: false });
  });
});

describe("the play record key", () => {
  it("reads the playId from the key, and refuses a key for another story", () => {
    assert.equal(playIdFromKey("play#story-1#abcdef12", "story-1"), "abcdef12");
    assert.equal(playIdFromKey("play#story-1#abcdef12", "story-2"), undefined);
    assert.equal(playIdFromKey("stat#story-1", "story-1"), undefined);
  });

  it("projects only the key, the story id and the time, and skips records whose key doesn't match", async () => {
    const seen: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        seen.push(command);
        return { Items: [{ id: "play#a#a-play-0001", storyId: "a", playedAt: at(1) }, { id: "stat#a", storyId: "a", playedAt: at(1) }] };
      },
    };
    const result = await dynamoPlaySource(client as never, "haunt-stats").recentPlays(NOW);
    assert.equal((seen[0] as QueryCommand).input.ProjectionExpression, "id, storyId, playedAt");
    assert.ok(result.records.every((r) => r.playId === "a-play-0001"), "a record with a mismatched key is skipped");
  });
});
