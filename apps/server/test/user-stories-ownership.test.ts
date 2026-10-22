import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoryInputSchema, UserStoryStore, type StoryInput } from "../src/user-stories.ts";

// My Stories ownership, against the real store with an in-memory stand-in for the DynamoDB calls it makes.
type Row = Record<string, unknown> & { userId: string; hauntId: string };

function fakeTable() {
  const rows = new Map<string, Row>();
  const keyOf = (userId: string, hauntId: string) => `${userId}|${hauntId}`;
  const failCondition = () => Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, any> }) => {
      const input = command.input;
      const name = command.constructor.name;
      if (name === "GetCommand") {
        const row = rows.get(keyOf(input.Key.userId, input.Key.hauntId));
        return { Item: row ? structuredClone(row) : undefined };
      }
      if (name === "QueryCommand") {
        if (input.IndexName) return { Items: [] };
        const userId = input.ExpressionAttributeValues[":u"];
        return { Items: [...rows.values()].filter((r) => r.userId === userId).map((r) => structuredClone(r)) };
      }
      if (name === "PutCommand") {
        const item = input.Item as Row;
        const k = keyOf(item.userId, item.hauntId);
        if (String(input.ConditionExpression).includes("attribute_not_exists(hauntId)") && rows.has(k)) throw failCondition();
        if (String(input.ConditionExpression).includes("#v = :e")) {
          const current = rows.get(k);
          if (!current || current.version !== input.ExpressionAttributeValues[":e"]) throw failCondition();
        }
        rows.set(k, structuredClone(item));
        return {};
      }
      if (name === "DeleteCommand") {
        const k = keyOf(input.Key.userId, input.Key.hauntId);
        const current = rows.get(k);
        if (!current || current.status !== "draft") throw failCondition();
        rows.delete(k);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
  return { store: new UserStoryStore(client as never, "haunt-user-stories", () => "2026-10-21T10:00:00.000Z"), rows };
}

const story = (title: string): StoryInput =>
  StoryInputSchema.parse({ title, author: "Pen Name", segments: [{ sceneIndex: 0, narration: "The door opens.", ending: true }] });

describe("My Stories ownership", () => {
  it("lists only the signed-in user's own stories", async () => {
    const { store } = fakeTable();
    const alice = await store.create("alice", story("Alice's tale"));
    await store.create("bob", story("Bob's tale"));
    const aliceList = await store.listFor("alice");
    assert.deepEqual(aliceList.map((s) => s.hauntId), [alice.hauntId]);
    assert.deepEqual((await store.listFor("carol")), []);
  });

  it("does not return another user's story by its id", async () => {
    const { store } = fakeTable();
    const alice = await store.create("alice", story("Alice's tale"));
    assert.equal(await store.get("bob", alice.hauntId), undefined);
    assert.ok(await store.get("alice", alice.hauntId));
  });

  it("refuses another user's edit and leaves the story unchanged", async () => {
    const { store } = fakeTable();
    const alice = await store.create("alice", story("Alice's tale"));
    await assert.rejects(store.update("bob", alice.hauntId, story("Hijacked"), alice.version), (error: { code?: string }) => error.code === "not_found");
    const after = await store.get("alice", alice.hauntId);
    assert.equal(after?.story.title, "Alice's tale");
    assert.equal(after?.version, alice.version);
  });

  it("refuses another user's delete and keeps the draft", async () => {
    const { store } = fakeTable();
    const alice = await store.create("alice", story("Alice's tale"));
    await assert.rejects(store.remove("bob", alice.hauntId), (error: { code?: string }) => error.code === "not_found");
    assert.ok(await store.get("alice", alice.hauntId));
  });

  it("refuses an edit made from a stale version, so a second window can't overwrite a newer save", async () => {
    const { store } = fakeTable();
    const alice = await store.create("alice", story("Alice's tale"));
    await store.update("alice", alice.hauntId, story("Newer"), alice.version);
    await assert.rejects(store.update("alice", alice.hauntId, story("Stale"), alice.version), (error: { code?: string }) => error.code === "conflict");
    assert.equal((await store.get("alice", alice.hauntId))?.story.title, "Newer");
  });

  it("lets the owner delete her own draft", async () => {
    const { store } = fakeTable();
    const alice = await store.create("alice", story("Alice's tale"));
    await store.remove("alice", alice.hauntId);
    assert.equal(await store.get("alice", alice.hauntId), undefined);
  });
});
