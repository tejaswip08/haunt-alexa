/**
 * Copy local JSON stories and library episodes (./data) into the DynamoDB table.
 *
 *   npm run migrate:dynamodb -w @haunt/server               # dry run: lists what would be copied
 *   npm run migrate:dynamodb -w @haunt/server -- --apply    # copies; never overwrites, never deletes
 *
 * Uses the AWS default credential chain (e.g. AWS_PROFILE=haunt) and HAUNT_TABLE_NAME.
 * Safe to run more than once. Story ids are listed; story contents are never printed.
 */
import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { FileStore } from "@firetales/core";
import { DynamoStore } from "@firetales/core/dynamodb";
import { config } from "../src/config.ts";
import { DynamoLibrary, FileLibrary } from "../src/library.ts";
import { migrate } from "../src/migrate.ts";

const apply = process.argv.includes("--apply");
const source = {
  stories: new FileStore(path.join(config.dataDir, "stories")),
  library: new FileLibrary(path.join(config.dataDir, "library")),
};
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion, maxAttempts: 4 }), {
  marshallOptions: { removeUndefinedValues: true },
});
const stories = new DynamoStore({ client, table: config.table, keyPrefix: "story#", ttlSeconds: config.storyTtlDays * 86_400 });
const library = new DynamoLibrary(client, config.table);

console.log(`${apply ? "Copying" : "Dry run: would copy"} from ${config.dataDir} to DynamoDB table "${config.table}" in ${config.awsRegion}`);
const report = await migrate(
  source,
  { putStoryIfAbsent: (s) => stories.putIfAbsent(s), putEntryIfAbsent: (e) => library.putIfAbsent(e) },
  { dryRun: !apply, onRecord: (kind, id, result) => console.log(`  ${kind} ${id}: ${result}`) },
);
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log("Nothing was written. Re-run with --apply to copy.");
