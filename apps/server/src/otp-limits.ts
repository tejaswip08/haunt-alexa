import { createHash } from "node:crypto";
import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * Shared, multi-instance limits for sign-in codes. Each request adds one to a counter stored in
 * the existing table; the counter's key includes the start of its window, so no reset is needed.
 * DynamoDB applies each ADD atomically, so two instances can't both pass the last free slot.
 *
 * Counters are items with partition key `otp-rl#<scope>#<window start>` and the table's TTL
 * attribute `expiresAt`. They never touch `story#` or `library#` items.
 */

export interface SharedLimiter {
  /** Counts one request. `ok` is false once the window's limit is used up. */
  hit(scope: string, limit: number, windowSeconds: number): Promise<{ ok: boolean; retryAfterSeconds: number }>;
}

/** A stable, non-reversible key for an email address (case-insensitive). */
export function emailKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function createSharedLimiter(
  client: Pick<DynamoDBDocumentClient, "send">,
  table: string,
  now: () => number = Date.now,
): SharedLimiter {
  return {
    async hit(scope, limit, windowSeconds) {
      const nowSeconds = Math.floor(now() / 1000);
      const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
      const windowEnd = windowStart + windowSeconds;
      const { Attributes } = await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { id: `otp-rl#${scope}#${windowStart}` },
          UpdateExpression: "ADD #count :one SET #expires = :expires",
          ExpressionAttributeNames: { "#count": "count", "#expires": "expiresAt" },
          // Keep the counter an hour past its window, then let TTL remove it.
          ExpressionAttributeValues: { ":one": 1, ":expires": windowEnd + 3600 },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      const count = Number(Attributes?.count ?? 0);
      return { ok: count <= limit, retryAfterSeconds: Math.max(1, windowEnd - nowSeconds) };
    },
  };
}
