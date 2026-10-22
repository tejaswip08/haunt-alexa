import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GetCommand, PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createMockProvider, createStoryEngine, storiesOwnedBy } from "../src/index.ts";
import { DynamoStore, StoryConflictError } from "../src/dynamodb.ts";

/** Just enough of DynamoDB's document API to exercise the store: Get, Put and paged Scan. */
function fakeDynamo(pageSize = 2) {
  const items = new Map<string, Record<string, unknown>>();
  const queries: string[] = [];
  const client = {
    async send(command: unknown) {
      if (command instanceof PutCommand) {
        const item = structuredClone(command.input.Item!);
        const existing = items.get(String(item.id));
        const condition = command.input.ConditionExpression;
        // Real DynamoDB rejects declared names or values that the expression doesn't use.
        for (const name of [...Object.keys(command.input.ExpressionAttributeNames ?? {}), ...Object.keys(command.input.ExpressionAttributeValues ?? {})]) {
          if (!condition?.includes(name)) {
            throw Object.assign(new Error(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${name}}`), { name: "ValidationException" });
          }
        }
        if (condition) {
          // Evaluates the three conditions DynamoStore uses.
          const expected = command.input.ExpressionAttributeValues?.[":expected"];
          const ok =
            !existing ||
            (condition.includes("attribute_not_exists(#version)") && existing.version === undefined) ||
            (condition.includes("#version = :expected") && existing.version === expected);
          if (!ok) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
        }
        items.set(String(item.id), item);
        return {};
      }
      if (command instanceof GetCommand) {
        return { Item: structuredClone(items.get(String(command.input.Key!.id))) };
      }
      if (command instanceof ScanCommand) {
        const prefix = String(command.input.ExpressionAttributeValues![":prefix"]);
        const owner = command.input.ExpressionAttributeValues![":owner"];
        const all = [...items.values()].filter((item) => String(item.id).startsWith(prefix) && (owner === undefined || item.ownerId === owner));
        const from = command.input.ExclusiveStartKey ? Number(command.input.ExclusiveStartKey.offset) : 0;
        const page = all.slice(from, from + pageSize);
        const more = from + pageSize < all.length;
        return { Items: page, LastEvaluatedKey: more ? { offset: from + pageSize } : undefined };
      }
      if (command instanceof QueryCommand) {
        queries.push(command.input.IndexName!);
        const { ":owner": owner, ":prefix": prefix } = command.input.ExpressionAttributeValues!;
        const found = [...items.values()].filter((item) => item.ownerId === owner && String(item.id).startsWith(String(prefix)));
        return { Items: found.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))) };
      }
      throw new Error("unexpected command");
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, items, queries };
}

describe("DynamoStore", () => {
  it("stores the owner and review status as attributes, and lists one owner's stories", async () => {
    for (const ownerIndex of [undefined, "ownerId-updatedAt"]) {
      const { client, items, queries } = fakeDynamo();
      const store = new DynamoStore({ client, table: "haunt-stories", ownerIndex });
      const engine = createStoryEngine({ provider: createMockProvider(), store });
      const mine = await engine.start({ premise: "Mine" }, { ownerId: "user-a" });
      await engine.start({ premise: "Theirs" }, { ownerId: "user-b" });
      await engine.start({ premise: "Nobody's" });
      assert.equal(items.get(`story#${mine.story.id}`)?.ownerId, "user-a");
      const story = (await store.get(mine.story.id))!;
      story.review = { status: "submitted", creator: "A", summary: "S", submittedAt: story.updatedAt };
      await store.put(story);
      assert.equal(items.get(`story#${mine.story.id}`)?.reviewStatus, "submitted");
      assert.deepEqual((await storiesOwnedBy(store, "user-a")).map((s) => s.id), [mine.story.id]);
      assert.deepEqual(queries, ownerIndex ? [ownerIndex] : [], ownerIndex ? "uses the index" : "scans without one");
    }
  });

  it("round-trips stories through prefixed keys", async () => {
    const { client, items } = fakeDynamo();
    const store = new DynamoStore({ client, table: "haunt-stories" });
    const engine = createStoryEngine({ provider: createMockProvider(), store });
    const { story } = await engine.start({ premise: "A radio that tunes itself at midnight" });
    const turn = await engine.decide(story.id, "Turn the dial");

    assert.ok(items.has(`story#${story.id}`));
    assert.equal((await store.get(story.id))?.scenes.length, 2);
    assert.equal(turn.story.decisions[0]?.answer, "Turn the dial");
    assert.equal(await store.get("st_missing"), undefined);
  });

  it("lists every story across scan pages, ignoring other records", async () => {
    const { client, items } = fakeDynamo(2);
    const store = new DynamoStore({ client, table: "haunt-stories" });
    const engine = createStoryEngine({ provider: createMockProvider(), store });
    for (const premise of ["One", "Two", "Three", "Four", "Five"]) await engine.start({ premise });
    items.set("library#x", { id: "library#x", episode: {} });
    assert.equal((await store.list()).length, 5);
  });

  it("versions every write, so a second server can't overwrite a newer turn", async () => {
    const { client, items } = fakeDynamo();
    const a = new DynamoStore({ client, table: "t" });
    const b = new DynamoStore({ client, table: "t" });
    const engine = createStoryEngine({ provider: createMockProvider(), store: a });
    const { story } = await engine.start({ premise: "Two servers, one story" });
    assert.equal(items.get(`story#${story.id}`)?.version, 1);

    // Both instances read version 1; the first to write wins, the second gets a conflict.
    const copyA = (await a.get(story.id))!;
    const copyB = (await b.get(story.id))!;
    await a.put({ ...copyA, title: "A wrote this" });
    assert.equal(items.get(`story#${story.id}`)?.version, 2);
    await assert.rejects(b.put({ ...copyB, title: "B wrote this" }), StoryConflictError);
    assert.equal((await a.get(story.id))?.title, "A wrote this");

    // After re-reading, B can write again.
    const fresh = (await b.get(story.id))!;
    await b.put({ ...fresh, title: "B, after re-reading" });
    assert.equal(items.get(`story#${story.id}`)?.version, 3);
  });

  it("a second server continues from the latest saved turn instead of overwriting it", async () => {
    const { client } = fakeDynamo();
    const a = new DynamoStore({ client, table: "t" });
    const b = new DynamoStore({ client, table: "t" });
    const engineA = createStoryEngine({ provider: createMockProvider(), store: a });
    const engineB = createStoryEngine({ provider: createMockProvider(), store: b });
    const { story } = await engineA.start({ premise: "Race" });
    await b.get(story.id); // B has an old copy in mind
    await engineA.decide(story.id, "Go left");
    // B's engine re-reads before writing, so it continues from A's turn instead of clobbering it.
    const turn = await engineB.decide(story.id, "Go right");
    assert.equal(turn.story.decisions.length, 2);
  });

  it("accepts stories written before versioning, then versions them", async () => {
    const { client, items } = fakeDynamo();
    const store = new DynamoStore({ client, table: "t" });
    const engine = createStoryEngine({ provider: createMockProvider(), store });
    const { story } = await engine.start({ premise: "Old item" });
    const legacy = { ...items.get(`story#${story.id}`)! };
    delete legacy.version;
    items.set(`story#${story.id}`, legacy);
    const fresh = new DynamoStore({ client, table: "t" });
    const loaded = (await fresh.get(story.id))!;
    await fresh.put(loaded);
    assert.equal(items.get(`story#${story.id}`)?.version, 1);
  });

  it("sets expiresAt for DynamoDB TTL when a retention period is configured", async () => {
    const { client, items } = fakeDynamo();
    const now = new Date("2026-10-17T00:00:00Z");
    const store = new DynamoStore({ client, table: "t", ttlSeconds: 30 * 86400, now: () => now });
    const engine = createStoryEngine({ provider: createMockProvider(), store });
    const { story } = await engine.start({ premise: "Expiring" });
    assert.equal(items.get(`story#${story.id}`)?.expiresAt, now.getTime() / 1000 + 30 * 86400);
    const untimed = new DynamoStore({ client, table: "t" });
    const { story: other } = await createStoryEngine({ provider: createMockProvider(), store: untimed }).start({ premise: "Kept" });
    assert.equal(items.get(`story#${other.id}`)?.expiresAt, undefined);
  });

  it("putIfAbsent never overwrites an existing story", async () => {
    const { client } = fakeDynamo();
    const store = new DynamoStore({ client, table: "t" });
    const { story } = await createStoryEngine({ provider: createMockProvider(), store }).start({ premise: "Original" });
    assert.equal(await store.putIfAbsent({ ...story, title: "Imposter" }), false);
    assert.notEqual((await store.get(story.id))?.title, "Imposter");
    assert.equal(await store.putIfAbsent({ ...story, id: "st_new" }), true);
  });
});
