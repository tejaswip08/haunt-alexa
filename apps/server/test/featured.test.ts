import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  activeFeatured,
  dynamoFeaturedStore,
  FEATURED_ID,
  FeatureVersionError,
  MAX_ACTIVE_FEATURED,
  MAX_FEATURE_MS,
  removeFeature,
  upsertFeature,
  validateFeature,
  type FeaturedEntry,
} from "../src/featured.ts";

const NOW = Date.UTC(2026, 9, 22, 18, 0, 0);
const iso = (offsetHours: number) => new Date(NOW + offsetHours * 3_600_000).toISOString();

describe("validating a selection on the server", () => {
  it("accepts a published-format story id and a UTC window that is open or in the future", () => {
    const result = validateFeature({ storyId: "story-1", startsAt: iso(-1), endsAt: iso(3) }, NOW);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.entry, { storyId: "story-1", startsAt: iso(-1), endsAt: iso(3) });
  });

  it("stores times as UTC, whatever offset they were sent with", () => {
    const result = validateFeature({ storyId: "story-1", startsAt: "2026-10-22T19:30:00+01:00", endsAt: "2026-10-22T22:00:00Z" }, NOW);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.entry.startsAt, "2026-10-22T18:30:00.000Z");
  });

  it("refuses an end that is not after the start, a window longer than 14 days, and a start too far ahead", () => {
    const backwards = validateFeature({ storyId: "a", startsAt: iso(2), endsAt: iso(1) }, NOW);
    assert.equal(backwards.ok, false);
    const long = validateFeature({ storyId: "a", startsAt: iso(1), endsAt: new Date(NOW + MAX_FEATURE_MS + 3_600_000 + 1).toISOString() }, NOW);
    assert.equal(long.ok, false);
    const far = validateFeature({ storyId: "a", startsAt: iso(24 * 61), endsAt: iso(24 * 62) }, NOW);
    assert.equal(far.ok, false);
  });

  it("refuses a window that has already ended, a bad story id, and times that are not dates", () => {
    assert.equal(validateFeature({ storyId: "a", startsAt: iso(-5), endsAt: iso(-1) }, NOW).ok, false);
    assert.equal(validateFeature({ storyId: "bad id!", startsAt: iso(0), endsAt: iso(1) }, NOW).ok, false);
    assert.equal(validateFeature({ storyId: "a", startsAt: "tomorrow", endsAt: iso(1) }, NOW).ok, false);
    assert.equal(validateFeature({ storyId: 42, startsAt: iso(0), endsAt: iso(1) }, NOW).ok, false);
  });
});

describe("which features are on air", () => {
  const e = (storyId: string, from: number, to: number): FeaturedEntry => ({ storyId, startsAt: iso(from), endsAt: iso(to) });

  it("shows only features whose window contains now, and stops a feature exactly at its end", () => {
    const entries = [e("open", -1, 2), e("ended", -5, -1), e("later", 1, 4), e("ends-now", -2, 0)];
    assert.deepEqual(activeFeatured(entries, NOW).map((x) => x.storyId), ["open"]);
  });

  it("orders by start time, then story id, and caps the number shown", () => {
    const entries = [e("b", -1, 5), e("a", -1, 5), e("c", -3, 5), e("d", -2, 5), e("e", -0.5, 5)];
    const shown = activeFeatured(entries, NOW).map((x) => x.storyId);
    assert.deepEqual(shown, ["c", "d", "a"].slice(0, MAX_ACTIVE_FEATURED), "earliest start first, ties by id");
    assert.equal(shown.length, MAX_ACTIVE_FEATURED);
  });

  it("returns nothing when nothing is scheduled, so the Home screen falls back", () => {
    assert.deepEqual(activeFeatured([], NOW), []);
  });
});

describe("changing the schedule", () => {
  const e = (storyId: string, from: number, to: number): FeaturedEntry => ({ storyId, startsAt: iso(from), endsAt: iso(to) });

  it("replaces a story's selection rather than adding a second one", () => {
    const next = upsertFeature([e("a", -1, 2)], e("a", 0, 5), NOW);
    assert.equal(next.length, 1);
    assert.equal(next[0]!.endsAt, iso(5));
  });

  it("removes a story's selection by id", () => {
    assert.deepEqual(removeFeature([e("a", 0, 1), e("b", 0, 1)], "a").map((x) => x.storyId), ["b"]);
    assert.deepEqual(removeFeature([e("a", 0, 1)], "missing").map((x) => x.storyId), ["a"]);
  });
});

describe("the stored schedule item", () => {
  type Stored = { id: string; entries: FeaturedEntry[]; version: number };
  /** A fake DynamoDB: holds one item and enforces the version condition the way DynamoDB does. */
  function fakeTable(initial?: Stored) {
    let item: Stored | undefined = initial;
    const writes: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        if (command instanceof PutCommand) {
          writes.push(command.input);
          const input = command.input;
          if (input.ConditionExpression === "attribute_not_exists(id)" && item) throw conditional();
          if (input.ConditionExpression === "#v = :expected" && item?.version !== input.ExpressionAttributeValues![":expected"]) throw conditional();
          item = input.Item as Stored;
          return {};
        }
        return { Item: item };
      },
    };
    return { client, writes, get item() { return item; } };
  }
  const conditional = () => new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });

  it("reads an empty schedule as version 0 and no entries", async () => {
    const t = fakeTable();
    assert.deepEqual(await dynamoFeaturedStore(t.client as never, "haunt-stats").read(), { entries: [], version: 0 });
  });

  it("writes the first version only if the item does not exist yet, and the next only if the version matches", async () => {
    const t = fakeTable();
    const store = dynamoFeaturedStore(t.client as never, "haunt-stats");
    assert.equal(await store.write([], 0, NOW), 1);
    assert.equal(t.item!.id, FEATURED_ID);
    assert.equal(await store.write([], 1, NOW), 2);
  });

  it("rejects a write based on an old version, so two admins can't overwrite each other", async () => {
    const t = fakeTable({ id: FEATURED_ID, entries: [], version: 3 });
    const store = dynamoFeaturedStore(t.client as never, "haunt-stats");
    await assert.rejects(store.write([], 2, NOW), FeatureVersionError);
    await assert.rejects(store.write([], 0, NOW), FeatureVersionError, "a write that expects no item fails when one exists");
  });

  it("lets a DynamoDB failure through, rather than pretending the save worked", async () => {
    const client = { send: async () => Promise.reject(Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" })) };
    await assert.rejects(dynamoFeaturedStore(client as never, "haunt-stats").write([], 0, NOW), /throttled/);
  });
});
