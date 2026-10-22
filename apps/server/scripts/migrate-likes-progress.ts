/**
 * Copies likes and progress from the legacy maps in haunt-users (and the like# items in haunt-stories) into haunt-likes and
 * haunt-progress. Phase 1 ships this script without running it. Nothing is written unless --apply is given, and --apply is
 * only meant for local DynamoDB until the migration has been reviewed and approved.
 *
 *   npx tsx scripts/migrate-likes-progress.ts              dry run: reads, counts, reconciles, writes nothing
 *   npx tsx scripts/migrate-likes-progress.ts --apply      backs up the legacy items, then copies (idempotent)
 *
 * Safety: the endpoint must be exactly http://localhost:8001 (fail closed, no fallback to AWS); AWS_PROFILE is refused.
 * Copies use conditional writes, so rerunning it adds nothing twice and never overwrites newer progress. Legacy data is read
 * and backed up, never deleted or rewritten.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { isConditionFailure } from "../src/split-records.ts";

const ENDPOINT = "http://localhost:8001";
const REGION = "us-east-1";
const USERS = "haunt-users";
const STORIES = "haunt-stories";
const LIKES = "haunt-likes";
const PROGRESS = "haunt-progress";

function requireLocal() {
  if (process.env.AWS_ENDPOINT_URL_DYNAMODB && process.env.AWS_ENDPOINT_URL_DYNAMODB !== ENDPOINT) {
    throw new Error(`AWS_ENDPOINT_URL_DYNAMODB must be ${ENDPOINT} or unset. Refusing to run.`);
  }
  if (process.env.AWS_PROFILE) throw new Error("AWS_PROFILE is set. Unset it; this script only talks to DynamoDB Local.");
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Export AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (any value works for DynamoDB Local).");
  }
}

async function scanAll(client: DynamoDBDocumentClient, table: string, filter?: { expr: string; names?: Record<string, string>; values?: Record<string, unknown> }) {
  const items: Record<string, any>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await client.send(
      new ScanCommand({
        TableName: table,
        ExclusiveStartKey: startKey,
        ...(filter ? { FilterExpression: filter.expr, ExpressionAttributeNames: filter.names, ExpressionAttributeValues: filter.values } : {}),
      }),
    );
    items.push(...(out.Items ?? []));
    startKey = out.LastEvaluatedKey;
  } while (startKey);
  return items;
}

interface Plan {
  likes: { userId: string; hauntId: string; createdAt: string }[];
  progress: { userId: string; hauntId: string; record: Record<string, unknown> }[];
  mismatches: string[];
  /** Records that are not valid enough to copy. They are reported, never written in a broken form. */
  skipped: string[];
}
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Builds the copy plan from the legacy data. Pure, so the dry run and the apply run show the same numbers. */
export function buildPlan(users: Record<string, any>[], likeItems: Record<string, any>[]): Plan {
  const plan: Plan = { likes: [], progress: [], mismatches: [], skipped: [] };
  const itemLikes = new Map<string, string>();
  for (const it of likeItems) {
    if (it.userId && it.storyId) itemLikes.set(`${it.userId}|${it.storyId}`, it.likedAt ?? "");
  }
  const mapLikes = new Map<string, string>();
  for (const u of users) {
    const userId = String(u.userId).replace(/#library$/, "");
    if (!String(u.userId).endsWith("#library")) continue;
    for (const [storyId, likedAt] of Object.entries<string>(u.likes ?? {})) mapLikes.set(`${userId}|${storyId}`, likedAt);
    for (const [storyId, p] of Object.entries<Record<string, any>>(u.progress ?? {})) {
      if (!isInt(p.partIndex) || !isInt(p.totalParts) || typeof p.completed !== "boolean" || !isIso(p.lastPlayedAt)) {
        plan.skipped.push(`${userId} / ${storyId}: progress is missing a required field; not copied`);
        continue;
      }
      plan.progress.push({
        userId,
        hauntId: storyId,
        record: {
          userId,
          hauntId: storyId,
          partIndex: p.partIndex,
          totalParts: p.totalParts,
          positionMs: p.positionMs ?? 0,
          completed: p.completed,
          lastPlayedAt: p.lastPlayedAt,
          ...(p.completedAt ? { completedAt: p.completedAt } : {}),
          ...(p.mode ? { mode: p.mode } : {}),
          ...(p.segment !== undefined ? { segment: p.segment } : {}),
          ...(p.history ? { history: p.history } : {}),
        },
      });
    }
  }
  // Every like is copied once: the union of the map and the like# items, keeping the earlier timestamp.
  for (const key of new Set([...mapLikes.keys(), ...itemLikes.keys()])) {
    const [userId, hauntId] = key.split("|") as [string, string];
    const a = mapLikes.get(key);
    const b = itemLikes.get(key);
    const usable = [a, b].filter((x): x is string => x !== undefined && x !== "");
    if (usable.length === 0 || !usable.every(isIso)) {
      plan.skipped.push(`${userId} / ${hauntId}: like has no valid timestamp; not copied`);
      continue;
    }
    if (a !== undefined && b !== undefined && a !== b) plan.mismatches.push(`${userId} / ${hauntId}: map and like# item disagree on the timestamp (kept the earlier)`);
    const createdAt = usable.sort()[0]!;
    plan.likes.push({ userId, hauntId, createdAt });
  }
  return plan;
}

async function main() {
  const apply = process.argv.includes("--apply");
  requireLocal();
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint: ENDPOINT, region: REGION }));

  const users = await scanAll(client, USERS, { expr: "attribute_exists(likes) OR attribute_exists(progress)" });
  const likeItems = await scanAll(client, STORIES, { expr: "begins_with(#id, :p)", names: { "#id": "id" }, values: { ":p": "like#" } });
  const plan = buildPlan(users, likeItems);

  console.log(`Legacy source: ${users.length} user record(s); ${likeItems.length} like# item(s) in ${STORIES}.`);
  console.log(`Plan: ${plan.likes.length} like(s) and ${plan.progress.length} progress record(s) to copy.`);
  console.log(`Reconciliation: ${plan.mismatches.length} discrepancy(ies) between the map and the like# items.`);
  console.log(`Skipped: ${plan.skipped.length} record(s) that are not valid enough to copy.`);
  for (const s of plan.skipped.slice(0, 20)) console.log(`  - ${s}`);
  for (const m of plan.mismatches.slice(0, 20)) console.log(`  - ${m}`);

  if (!apply) {
    console.log("Dry run. Nothing was written. Add --apply to copy (local DynamoDB only, after approval).");
    return;
  }

  const dir = join(homedir(), "haunt-restore-backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(dir, `likes-progress-source-${stamp}.json`);
  writeFileSync(backup, JSON.stringify({ taken: stamp, endpoint: ENDPOINT, users, likeItems }, null, 2), { mode: 0o600 });
  console.log(`Backup of the legacy source written to ${backup} (outside the repository).`);

  let likesCopied = 0;
  for (const like of plan.likes) {
    try {
      await client.send(
        new PutCommand({
          TableName: LIKES,
          Item: { userId: like.userId, hauntId: like.hauntId, liked: true, createdAt: like.createdAt, updatedAt: like.createdAt },
          ConditionExpression: "attribute_not_exists(hauntId)",
        }),
      );
      likesCopied += 1;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }
  let progressCopied = 0;
  for (const p of plan.progress) {
    // Same rule as the server: a stored record that is newer (or equal and further along) is never overwritten.
    try {
      await client.send(
        new PutCommand({
          TableName: PROGRESS,
          Item: p.record,
          ConditionExpression:
            "attribute_not_exists(hauntId) OR lastPlayedAt < :t OR (lastPlayedAt = :t AND partIndex <= :p)",
          ExpressionAttributeValues: { ":t": p.record.lastPlayedAt, ":p": p.record.partIndex },
        }),
      );
      progressCopied += 1;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }
  console.log(`Copied ${likesCopied} like(s) and ${progressCopied} progress record(s). Already present ones were left as they are.`);
  console.log("Next: read-back verification and count comparison, before any cutover.");
}

main().catch((error: Error) => {
  console.error(`migration failed: ${error.message}`);
  process.exitCode = 1;
});
