/**
 * Keep DynamoDB stories until at least a date (only ever extends their TTL).
 *
 *   npm run extend-expiry -w @haunt/server -- --until 2026-12-01            # dry run
 *   npm run extend-expiry -w @haunt/server -- --until 2026-12-01 --apply    # writes
 *
 * Uses the AWS default credential chain (e.g. AWS_PROFILE=haunt) and HAUNT_TABLE_NAME.
 * Changes only `expiresAt`; story contents are never read or printed.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { config } from "../src/config.ts";
import { extendStoryExpiry } from "../src/extend-expiry.ts";

const arg = process.argv[process.argv.indexOf("--until") + 1];
const until = arg && process.argv.includes("--until") ? new Date(`${arg}T00:00:00Z`) : undefined;
if (!until || Number.isNaN(until.getTime())) {
  console.error("Usage: extend-story-expiry --until YYYY-MM-DD [--apply]");
  process.exit(1);
}
const apply = process.argv.includes("--apply");
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion, maxAttempts: 4 }));
const iso = (s?: number) => (s === undefined ? "never" : new Date(s * 1000).toISOString().slice(0, 10));
console.log(`${apply ? "Extending" : "Dry run:"} stories in "${config.table}" (${config.awsRegion}) to expire no earlier than ${iso(until.getTime() / 1000)}`);
const report = await extendStoryExpiry(client, {
  table: config.table,
  until,
  dryRun: !apply,
  onItem: (id, from, action) => console.log(`  ${id}: ${iso(from)} → ${action}`),
});
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log("Nothing was written. Re-run with --apply.");
