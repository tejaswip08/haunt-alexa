import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { EngagementStore } from "../src/engagement.ts";

// A play is written with its playedAt and trendDay in the same transaction, so both always agree. The client is a
// fake: the test checks what is sent, and never reaches DynamoDB.
describe("a recorded play", () => {
  it("is written with a trendDay equal to the UTC day of its playedAt, in the same transaction as the count", async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        sent.push(command);
        return {};
      },
    };
    const store = new EngagementStore(client as never, "haunt-stats", undefined, "haunt-stats");
    // The store reads the totals after the write; an empty result is fine for this check.
    await store.recordPlay("story-1", "play-abcdef12").catch(() => undefined);
    const write = sent.find((c) => c instanceof TransactWriteCommand) as TransactWriteCommand | undefined;
    assert.ok(write, "the play is written in one transaction");
    const put = write!.input.TransactItems![0]!.Put!;
    assert.equal(put.ConditionExpression, "attribute_not_exists(id)", "still idempotent by playId");
    assert.equal(put.Item!.id, "play#story-1#play-abcdef12");
    assert.match(String(put.Item!.playedAt), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(put.Item!.trendDay, String(put.Item!.playedAt).slice(0, 10));
  });
});
