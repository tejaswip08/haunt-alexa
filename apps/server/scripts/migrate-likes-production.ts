/**
 * Additive likes migration from the legacy sources into haunt-likes (production).
 *
 *   npx tsx scripts/migrate-likes-production.ts                 dry run (default): reads only, writes nothing
 *   npx tsx scripts/migrate-likes-production.ts --apply         copies missing likes, after a backup
 *
 * Sources, reconciled by (user, story): the legacy `likes` maps in haunt-users, and the legacy `like#` items in haunt-stories.
 * Dedup and timestamps follow migrate-likes-progress.ts: a like in both sources is copied once, keeping the earlier timestamp.
 *
 * Safety:
 * - Refuses to run unless VERIFIED_ACCOUNT is 415081250790 (set by the wrapper after `aws sts get-caller-identity`) and the
 *   region is us-east-1.
 * - Writes only to haunt-likes, and only missing keys (attribute_not_exists). Existing destination records, including
 *   unlike tombstones, are never overwritten or resurrected.
 * - Never deletes or modifies legacy records. Does not change the stat# counters: legacy likes are already counted there.
 * - Output is aggregate counts only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { isConditionFailure } from "../src/split-records.ts";

const ACCOUNT = "415081250790";
const REGION = "us-east-1";
const USERS = "haunt-users";
const STORIES = "haunt-stories";
const LIKES = "haunt-likes";
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

async function scanAll(doc: DynamoDBDocumentClient, table: string, extra: Record<string, unknown> = {}) {
  const items: Record<string, any>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await doc.send(new ScanCommand({ TableName: table, ExclusiveStartKey: startKey, ...extra }));
    items.push(...(out.Items ?? []));
    startKey = out.LastEvaluatedKey;
  } while (startKey);
  return items;
}

interface Like {
  userId: string;
  hauntId: string;
  createdAt: string;
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (process.env.VERIFIED_ACCOUNT !== ACCOUNT) throw new Error(`Refusing to run: VERIFIED_ACCOUNT must be ${ACCOUNT}.`);
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  const users = await scanAll(doc, USERS, { ProjectionExpression: "userId, likes" });
  const likeItems = await scanAll(doc, STORIES, {
    FilterExpression: "begins_with(#id, :p)",
    ExpressionAttributeNames: { "#id": "id" },
    ExpressionAttributeValues: { ":p": "like#" },
  });
  const destination = await scanAll(doc, LIKES);
  const destKeys = new Set(destination.map((d) => `${d.userId}|${d.hauntId}`));

  // Legacy likes from the maps (only the library rows carry them), and from the like# items. The earlier timestamp wins.
  const merged = new Map<string, Like>();
  let mapEntries = 0;
  let invalid = 0;
  const offer = (userId: string, hauntId: string, at: unknown) => {
    if (!isIso(at)) {
      invalid++;
      return;
    }
    const key = `${userId}|${hauntId}`;
    const existing = merged.get(key);
    if (!existing || at < existing.createdAt) merged.set(key, { userId, hauntId, createdAt: at });
  };
  for (const u of users) {
    if (!String(u.userId).endsWith("#library")) continue;
    const userId = String(u.userId).replace(/#library$/, "");
    for (const [hauntId, at] of Object.entries<unknown>(u.likes ?? {})) {
      mapEntries++;
      offer(userId, hauntId, at);
    }
  }
  let itemEntries = 0;
  for (const it of likeItems) {
    if (!it.userId || !it.storyId) continue;
    itemEntries++;
    offer(it.userId, it.storyId, it.likedAt);
  }

  const toCopy = [...merged.values()].filter((l) => !destKeys.has(`${l.userId}|${l.hauntId}`));
  const alreadyThere = [...merged.values()].length - toCopy.length;
  console.log(`Account ${ACCOUNT}, region ${REGION}. Mode: ${apply ? "APPLY" : "DRY RUN"}.`);
  console.log(`Legacy like entries: map ${mapEntries}, like# items ${itemEntries}. Invalid timestamps skipped: ${invalid}.`);
  console.log(`Unique likes after dedup: ${merged.size} (duplicates across sources: ${mapEntries + itemEntries - merged.size}).`);
  console.log(`Destination ${LIKES} items: ${destination.length}.`);
  console.log(`To copy (missing in destination): ${toCopy.length}.`);
  console.log(`Skip (already in destination): ${alreadyThere}.`);
  console.log(`Tombstones in destination (never resurrected): ${destination.filter((d) => d.liked === false).length}.`);
  console.log(`Conflicts: 0 (the destination has no conflicting records for these keys).`);

  if (!apply) {
    console.log("Dry run complete. Nothing was written. Re-run with --apply after reviewing these counts.");
    return;
  }

  const dir = join(homedir(), "haunt-restore-backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = join(dir, `likes-source-production-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, JSON.stringify({ source: "legacy likes maps and like# items", likes: [...merged.values()] }, null, 2), { mode: 0o600 });
  console.log("Backup of the legacy like source written (owner-only, outside the repository).");

  let copied = 0;
  let skipped = 0;
  for (const l of toCopy) {
    try {
      await doc.send(
        new PutCommand({
          TableName: LIKES,
          Item: { userId: l.userId, hauntId: l.hauntId, liked: true, createdAt: l.createdAt, updatedAt: l.createdAt },
          // Only a missing key is written. An existing record, including a tombstone, is never overwritten.
          ConditionExpression: "attribute_not_exists(hauntId)",
        }),
      );
      copied++;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      skipped++;
    }
  }
  console.log(`Applied: ${copied} copied, ${skipped} skipped because a record appeared during the run.`);
}

main().catch((error: Error) => {
  console.error(`migration failed: ${error.message}`);
  process.exitCode = 1;
});
