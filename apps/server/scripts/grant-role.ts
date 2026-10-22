/**
 * Operator tool: grants or revokes a Haunt role on one account. Run from a trusted AWS identity (for example
 * your SSO admin profile). There is no HTTP endpoint for this, so no signed-in user can promote anyone, and
 * nothing is granted by registration order, email address, or client data.
 *
 *   # dry run (reads only): shows the change, writes nothing
 *   AWS_PROFILE=haunt npx tsx scripts/grant-role.ts --sub <cognito-sub> --from LISTENER --to ADMIN --reason "first admin"
 *
 *   # apply: a conditional update, so it only succeeds if the account still has the --from role
 *   AWS_PROFILE=haunt npx tsx scripts/grant-role.ts --sub <cognito-sub> --from LISTENER --to ADMIN --reason "first admin" --apply
 *
 * Revoking Admin access: --from ADMIN --to LISTENER. Every change writes an audit record with the actor, target,
 * previous role, new role, reason, and time, in the same transaction as the change.
 *
 * Environment: AWS_REGION (default us-east-1) and HAUNT_USERS_TABLE (default haunt-users).
 */
import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

const ROLES = ["LISTENER", "CREATOR", "ADMIN"] as const;
type Role = (typeof ROLES)[number];
const SUB = /^[0-9a-fA-F-]{8,64}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sub = arg("sub");
const from = arg("from") as Role | undefined;
const to = arg("to") as Role | undefined;
const reason = (arg("reason") ?? "").trim().slice(0, 280);
const apply = process.argv.includes("--apply");
const table = process.env.HAUNT_USERS_TABLE ?? "haunt-users";
const region = process.env.AWS_REGION ?? "us-east-1";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!sub || !SUB.test(sub)) fail("Give the account's Cognito sub with --sub (a UUID).");
if (!from || !ROLES.includes(from)) fail(`--from must be one of ${ROLES.join(", ")}.`);
if (!to || !ROLES.includes(to)) fail(`--to must be one of ${ROLES.join(", ")}.`);
if (from === to) fail("--from and --to are the same: nothing to do.");
if (!reason) fail("Give a --reason. It is recorded in the audit trail.");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const { Item } = await client.send(new GetCommand({ TableName: table, Key: { userId: sub }, ConsistentRead: true }));
if (!Item) fail("No profile exists for that sub. The account must sign in once first.");
const current = (Item.role as Role | undefined) ?? "LISTENER";
if (current !== from) fail(`The account is ${current}, not ${from}. Nothing was changed.`);

console.log(`${apply ? "Applying" : "Dry run (reads only)"}: ${sub} ${from} -> ${to} in "${table}" (${region})`);
if (!apply) {
  console.log("Nothing was written. Re-run with --apply to change the role.");
  process.exit(0);
}

const stamp = new Date().toISOString();
try {
  await client.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: table,
            Key: { userId: sub },
            UpdateExpression: "SET #role = :to, #updatedAt = :stamp",
            // Only if the role is still the expected one: a concurrent change makes this fail, not overwrite.
            ConditionExpression: from === "LISTENER" ? "attribute_exists(userId) AND (attribute_not_exists(#role) OR #role = :from)" : "attribute_exists(userId) AND #role = :from",
            ExpressionAttributeNames: { "#role": "role", "#updatedAt": "updatedAt" },
            ExpressionAttributeValues: { ":to": to, ":from": from, ":stamp": stamp },
          },
        },
        {
          Put: {
            TableName: table,
            Item: {
              userId: `audit#${stamp}#${randomBytes(8).toString("hex")}`,
              audit: { actor: "operator-cli", target: sub, previousRole: from, newRole: to, reason, at: stamp },
            },
            ConditionExpression: "attribute_not_exists(userId)",
          },
        },
      ],
    }),
  );
  console.log(`Done: ${sub} is now ${to}. Audit record written.`);
} catch (error) {
  fail(`The change was not applied (${(error as Error).name}). The account may have changed since it was read.`);
}
