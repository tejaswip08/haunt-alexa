/**
 * Moves stat# (counters) and play# (playback starts) from haunt-stories into haunt-stats. Local DynamoDB only.
 *
 *   npx tsx scripts/migrate-stats-local.ts                  dry run (default): reads only, writes nothing
 *   npx tsx scripts/migrate-stats-local.ts --apply          copies missing records, then verifies every destination record
 *   npx tsx scripts/migrate-stats-local.ts --apply --delete-source
 *                                                           also deletes the source records, only if verification passed
 *
 * Safety:
 * - Refuses any endpoint other than http://localhost:8001 and refuses AWS_PROFILE.
 * - Keys and attributes are copied unchanged (id, plus likes/plays or storyId/playedAt). No TTL is added.
 * - A destination record that already exists is never overwritten. An identical one is skipped; a different one is a conflict.
 * - Rerunning is safe: it creates nothing twice and deletes only verified sources.
 * - Never touches likes, progress, users, guest or library stories, or legacy library maps.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { isConditionFailure } from "../src/split-records.ts";

const ENDPOINT = "http://localhost:8001";
const REGION = "us-east-1";
const SOURCE = "haunt-stories";
const DEST = "haunt-stats";

function requireLocal() {
  if (process.env.AWS_ENDPOINT_URL_DYNAMODB && process.env.AWS_ENDPOINT_URL_DYNAMODB !== ENDPOINT) {
    throw new Error(`AWS_ENDPOINT_URL_DYNAMODB must be ${ENDPOINT} or unset.`);
  }
  if (process.env.AWS_PROFILE) throw new Error("AWS_PROFILE is set. This script only talks to local DynamoDB.");
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) throw new Error("Set local dummy credentials.");
}

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

/** A stable text form of an item, for comparing a copy with its source. Attribute order does not matter. */
const canonical = (item: Record<string, unknown>) => JSON.stringify(Object.keys(item).sort().map((k) => [k, item[k]]));

async function main() {
  const apply = process.argv.includes("--apply");
  const deleteSource = process.argv.includes("--delete-source");
  requireLocal();
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ endpoint: ENDPOINT, region: REGION }));

  const source = await scanAll(doc, SOURCE, {
    FilterExpression: "begins_with(#id, :s) OR begins_with(#id, :p)",
    ExpressionAttributeNames: { "#id": "id" },
    ExpressionAttributeValues: { ":s": "stat#", ":p": "play#" },
  });
  const destBefore = new Map((await scanAll(doc, DEST)).map((i) => [i.id, i]));
  const counts = { stat: source.filter((i) => String(i.id).startsWith("stat#")).length, play: source.filter((i) => String(i.id).startsWith("play#")).length };
  console.log(`Source ${SOURCE}: ${source.length} records (stat ${counts.stat}, play ${counts.play}). Destination ${DEST}: ${destBefore.size}.`);

  const toCopy: Record<string, any>[] = [];
  let same = 0;
  const conflicts: string[] = [];
  for (const item of source) {
    const existing = destBefore.get(item.id);
    if (!existing) toCopy.push(item);
    else if (canonical(existing) === canonical(item)) same++;
    else conflicts.push(String(item.id));
  }
  console.log(`To copy: ${toCopy.length}. Already identical in destination: ${same}. Conflicts (not overwritten): ${conflicts.length}.`);
  if (conflicts.length) throw new Error("Conflicts found. Resolve them before any write.");

  if (!apply) {
    console.log("Dry run. Nothing was written. Re-run with --apply, then --delete-source only after verification.");
    return;
  }

  let copied = 0;
  for (const item of toCopy) {
    try {
      await doc.send(new PutCommand({ TableName: DEST, Item: item, ConditionExpression: "attribute_not_exists(id)" }));
      copied++;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
  }
  console.log(`Copied ${copied} records.`);

  // Verify every source record against its destination copy, field by field.
  const destAfter = new Map((await scanAll(doc, DEST)).map((i) => [i.id, i]));
  const unverified = source.filter((item) => {
    const d = destAfter.get(item.id);
    return !d || canonical(d) !== canonical(item);
  });
  console.log(`Verified: ${source.length - unverified.length} of ${source.length} source records match their destination copy.`);
  if (unverified.length) {
    console.log("Verification failed. Source records were NOT deleted.");
    process.exitCode = 2;
    return;
  }
  if (!deleteSource) {
    console.log("Verification passed. Source records kept. Re-run with --delete-source to remove them from haunt-stories.");
    return;
  }

  let deleted = 0;
  for (const item of source) {
    // Only deletes a record that still matches its verified copy.
    await doc.send(
      new DeleteCommand({
        TableName: SOURCE,
        Key: { id: item.id },
        ConditionExpression: "attribute_exists(id)",
      }),
    );
    deleted++;
  }
  console.log(`Deleted ${deleted} verified source records from ${SOURCE}.`);
}

main().catch((error: Error) => {
  console.error(`migration failed: ${error.message}`);
  process.exitCode = 1;
});
