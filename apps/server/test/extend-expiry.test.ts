import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { extendStoryExpiry } from "../src/extend-expiry.ts";

function fake(items: Record<string, unknown>[]) {
  const updates: string[] = [];
  const client = {
    async send(command: unknown) {
      if (command instanceof ScanCommand) return { Items: items.filter((i) => String(i.id).startsWith("story#")) };
      if (command instanceof UpdateCommand) {
        const item = items.find((i) => i.id === command.input.Key!.id)!;
        const until = command.input.ExpressionAttributeValues![":until"] as number;
        if (!(typeof item.expiresAt === "number" && item.expiresAt < until)) {
          throw Object.assign(new Error("failed"), { name: "ConditionalCheckFailedException" });
        }
        item.expiresAt = until;
        updates.push(String(item.id));
        return {};
      }
      throw new Error("unexpected");
    },
  };
  return { client, updates };
}

const until = new Date("2026-12-01T00:00:00Z");
const t = (iso: string) => new Date(iso).getTime() / 1000;

describe("Extending story expiry", () => {
  it("dry run changes nothing", async () => {
    const items = [{ id: "story#a", expiresAt: t("2026-11-16T00:00:00Z") }];
    const { client, updates } = fake(items);
    const report = await extendStoryExpiry(client as never, { table: "t", until, dryRun: true });
    assert.deepEqual(report, { scanned: 1, extended: 1, alreadyLater: 0, dryRun: true });
    assert.equal(updates.length, 0);
    assert.equal(items[0]!.expiresAt, t("2026-11-16T00:00:00Z"));
  });

  it("only extends, never shortens, and leaves never-expiring and library items alone", async () => {
    const items: Record<string, unknown>[] = [
      { id: "story#early", expiresAt: t("2026-11-16T00:00:00Z") },
      { id: "story#later", expiresAt: t("2027-01-01T00:00:00Z") },
      { id: "story#forever" },
      { id: "library#x" },
    ];
    const { client, updates } = fake(items);
    const report = await extendStoryExpiry(client as never, { table: "t", until, dryRun: false });
    assert.deepEqual(updates, ["story#early"]);
    assert.equal(report.extended, 1);
    assert.equal(report.alreadyLater, 2);
    assert.equal(items[0]!.expiresAt, until.getTime() / 1000);
    assert.equal(items[1]!.expiresAt, t("2027-01-01T00:00:00Z"));
    assert.equal(items[2]!.expiresAt, undefined);
  });
});
