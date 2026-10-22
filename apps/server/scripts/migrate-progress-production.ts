/**
 * Progress-only, additive migration from the legacy `progress` maps in haunt-users into haunt-progress (production).
 *
 *   npx tsx scripts/migrate-progress-production.ts                 dry run (default): reads only, writes nothing
 *   npx tsx scripts/migrate-progress-production.ts --apply         copies missing or older records, after a backup
 *
 * Safety:
  * - Refuses to run unless VERIFIED_ACCOUNT is 415081250790 (set after an STS check) and the region is us-east-1.
 * - Never writes the likes table and never touches haunt-users or haunt-stories.
 * - Never deletes or modifies legacy records. Writes only to haunt-progress.
 * - Writes are conditional, using the same newer-wins rule as split-records.ts saveProgress: a stored record that is newer,
 *   or equal and further along, is never overwritten. Reruns are idempotent and safe after a partial failure.
 * - Output is aggregate counts only. User IDs and progress details are never printed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { isConditionFailure } from "../src/split-records.ts";

const ACCOUNT = "415081250790";
const REGION = "us-east-1";
const USERS = "haunt-users";
const PROGRESS = "haunt-progress";

interface Legacy {
  userId: string;
  hauntId: string;
  record: Record<string, unknown>;
  lastPlayedAt: string;
  partIndex: number;
}

const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
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

/** The legacy progress entries, validated the same way the local migration validates them. Invalid entries are counted, not copied. */
function legacyEntries(users: Record<string, any>[]): { valid: Legacy[]; invalid: number } {
  const valid: Legacy[] = [];
  let invalid = 0;
  for (const u of users) {
    if (!String(u.userId).endsWith("#library")) continue;
    const userId = String(u.userId).replace(/#library$/, "");
    for (const [hauntId, raw] of Object.entries<Record<string, any>>(u.progress ?? {})) {
      if (!isInt(raw.partIndex) || !isInt(raw.totalParts) || typeof raw.completed !== "boolean" || !isIso(raw.lastPlayedAt)) {
        invalid++;
        continue;
      }
      const record = {
        userId,
        hauntId,
        partIndex: raw.partIndex,
        totalParts: raw.totalParts,
        positionMs: raw.positionMs ?? 0,
        completed: raw.completed,
        lastPlayedAt: raw.lastPlayedAt,
        ...(raw.completedAt ? { completedAt: raw.completedAt } : {}),
        ...(raw.mode ? { mode: raw.mode } : {}),
        ...(raw.segment !== undefined ? { segment: raw.segment } : {}),
        ...(raw.history ? { history: raw.history } : {}),
      };
      valid.push({ userId, hauntId, record, lastPlayedAt: raw.lastPlayedAt, partIndex: raw.partIndex });
    }
  }
  return { valid, invalid };
}

interface Plan {
  copyMissing: Legacy[];
  copyOlder: Legacy[];
  skipNewerDestination: number;
  sameAsDestination: number;
  conflictSameTimeDifferent: Legacy[];
}

/** Reconciles each legacy entry against the destination by key. Only missing or demonstrably older destinations are copied. */
function plan(legacy: Legacy[], dest: Map<string, Record<string, any>>): Plan {
  const out: Plan = { copyMissing: [], copyOlder: [], skipNewerDestination: 0, sameAsDestination: 0, conflictSameTimeDifferent: [] };
  for (const l of legacy) {
    const d = dest.get(`${l.userId}|${l.hauntId}`);
    if (!d) {
      out.copyMissing.push(l);
      continue;
    }
    const dAt = String(d.lastPlayedAt ?? "");
    if (dAt < l.lastPlayedAt) out.copyOlder.push(l);
    else if (dAt > l.lastPlayedAt) out.skipNewerDestination++;
    else if (Number(d.partIndex) === l.partIndex && d.completed === l.record.completed) out.sameAsDestination++;
    else out.conflictSameTimeDifferent.push(l);
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  // The wrapper verifies the account with `aws sts get-caller-identity --profile haunt` and passes it in. The check fails closed.
  if (process.env.VERIFIED_ACCOUNT !== ACCOUNT) throw new Error(`Refusing to run: VERIFIED_ACCOUNT must be ${ACCOUNT} (set by the wrapper after an STS check).`);
  const client = new DynamoDBClient({ region: REGION });
  const doc = DynamoDBDocumentClient.from(client);

  const users = await scanAll(doc, USERS, { ProjectionExpression: "userId, progress" });
  const { valid, invalid } = legacyEntries(users);
  const destItems = await scanAll(doc, PROGRESS);
  const dest = new Map(destItems.map((d) => [`${d.userId}|${d.hauntId}`, d]));
  const p = plan(valid, dest);

  console.log(`Account ${ACCOUNT}, region ${REGION}. Mode: ${apply ? "APPLY" : "DRY RUN"}.`);
  console.log(`Legacy progress entries: ${valid.length + invalid} (valid ${valid.length}, invalid and skipped ${invalid}).`);
  console.log(`Destination ${PROGRESS} items: ${destItems.length}.`);
  console.log(`To copy (missing in destination): ${p.copyMissing.length}.`);
  console.log(`To copy (destination older): ${p.copyOlder.length}.`);
  console.log(`Skip (destination newer, preserved): ${p.skipNewerDestination}.`);
  console.log(`Skip (identical): ${p.sameAsDestination}.`);
  console.log(`Conflicts (same timestamp, different content): ${p.conflictSameTimeDifferent.length}.`);

  if (p.conflictSameTimeDifferent.length > 0) {
    throw new Error("Unresolved conflicts. Stop and resolve them manually before any write.");
  }
  if (!apply) {
    console.log("Dry run complete. Nothing was written. Re-run with --apply after reviewing these counts.");
    return;
  }

  // A backup of the legacy progress source, outside the repository, owner-only. It contains personal progress data: keep it private.
  const dir = join(homedir(), "haunt-restore-backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backup = join(dir, `progress-source-production-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(backup, JSON.stringify({ source: USERS, progress: valid.map((v) => v.record) }, null, 2), { mode: 0o600 });
  console.log(`Backup of the legacy progress source written (owner-only, outside the repository).`);

  let copied = 0;
  let raced = 0;
  for (const l of [...p.copyMissing, ...p.copyOlder]) {
    try {
      await doc.send(
        new PutCommand({
          TableName: PROGRESS,
          Item: l.record,
          // Same rule as split-records.ts: write only when nothing is stored, or the stored record is older (or equal and behind).
          ConditionExpression: "attribute_not_exists(hauntId) OR lastPlayedAt < :t OR (lastPlayedAt = :t AND partIndex <= :p)",
          ExpressionAttributeValues: { ":t": l.lastPlayedAt, ":p": l.partIndex },
        }),
      );
      copied++;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      raced++; // a newer record appeared since the scan; it is preserved
    }
  }
  console.log(`Applied: ${copied} copied, ${raced} skipped because a newer record appeared during the run.`);
  void GetCommand;
}

main().catch((error: Error) => {
  console.error(`migration failed: ${error.message}`);
  process.exitCode = 1;
});
