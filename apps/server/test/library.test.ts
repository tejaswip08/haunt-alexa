import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoLibrary, type LibraryEntry } from "../src/library.ts";

/** Get, conditional Put, Delete and paged Scan, like the real table. */
function fakeTable(pageSize = 2) {
  const items = new Map<string, Record<string, unknown>>();
  const client = {
    async send(command: unknown) {
      if (command instanceof PutCommand) {
        const item = structuredClone(command.input.Item!);
        if (command.input.ConditionExpression === "attribute_not_exists(id)" && items.has(String(item.id))) {
          throw Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
        }
        items.set(String(item.id), item);
        return {};
      }
      if (command instanceof GetCommand) return { Item: structuredClone(items.get(String(command.input.Key!.id))) };
      if (command instanceof DeleteCommand) return void items.delete(String(command.input.Key!.id)), {};
      if (command instanceof ScanCommand) {
        const prefix = String(command.input.ExpressionAttributeValues![":prefix"]);
        const all = [...items.values()].filter((i) => String(i.id).startsWith(prefix));
        const from = command.input.ExclusiveStartKey ? Number(command.input.ExclusiveStartKey.offset) : 0;
        return { Items: all.slice(from, from + pageSize), LastEvaluatedKey: from + pageSize < all.length ? { offset: from + pageSize } : undefined };
      }
      throw new Error("unexpected command");
    },
  };
  return { client, items };
}

const entry = (storyId: string, publishedAt: string): LibraryEntry =>
  ({ episode: { storyId, title: storyId, segments: [] }, creator: "Pen", summary: "s", publishedAt }) as unknown as LibraryEntry;

describe("DynamoDB library", () => {
  it("creates, reads, lists newest first across pages, and deletes", async () => {
    const { client, items } = fakeTable(2);
    const library = new DynamoLibrary(client, "t");
    for (const [id, at] of [["a", "2026-10-01"], ["b", "2026-10-03"], ["c", "2026-10-02"]] as const) await library.put(entry(id, at));
    items.set("story#x", { id: "story#x", story: {} }); // stories share the table and are ignored
    assert.equal((await library.get("b"))?.episode.storyId, "b");
    assert.equal(await library.get("missing"), undefined);
    assert.deepEqual((await library.list()).map((e) => e.episode.storyId), ["b", "c", "a"]);
    await library.remove("b");
    assert.equal(await library.get("b"), undefined);
    assert.equal((await library.list()).length, 2);
  });

  it("putIfAbsent never overwrites an existing entry", async () => {
    const { client } = fakeTable();
    const library = new DynamoLibrary(client, "t");
    assert.equal(await library.putIfAbsent(entry("a", "2026-10-01")), true);
    assert.equal(await library.putIfAbsent({ ...entry("a", "2026-10-09"), summary: "changed" }), false);
    assert.equal((await library.get("a"))?.summary, "s");
  });
});
