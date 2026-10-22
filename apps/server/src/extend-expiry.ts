import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface ExtendReport {
  scanned: number;
  extended: number;
  alreadyLater: number;
  dryRun: boolean;
}

/**
 * Moves stories' TTL (`expiresAt`) to at least `until`. Only ever extends: an item that
 * already expires later, or never, is left alone. Only `expiresAt` changes; the story,
 * its `version` and every other attribute are untouched.
 */
export async function extendStoryExpiry(
  client: Pick<DynamoDBDocumentClient, "send">,
  options: { table: string; until: Date; dryRun: boolean; prefix?: string; onItem?: (id: string, from: number | undefined, action: string) => void },
): Promise<ExtendReport> {
  const { table, dryRun, prefix = "story#", onItem } = options;
  const until = Math.floor(options.until.getTime() / 1000);
  const report: ExtendReport = { scanned: 0, extended: 0, alreadyLater: 0, dryRun };
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: table,
        ProjectionExpression: "id, expiresAt",
        FilterExpression: "begins_with(id, :prefix)",
        ExpressionAttributeValues: { ":prefix": prefix },
        ExclusiveStartKey: start,
      }),
    );
    for (const item of page.Items ?? []) {
      report.scanned++;
      const id = String(item.id);
      const current = typeof item.expiresAt === "number" ? item.expiresAt : undefined;
      // No expiresAt means "never expires": leave it that way.
      if (current === undefined || current >= until) {
        report.alreadyLater++;
        onItem?.(id, current, "unchanged");
        continue;
      }
      if (!dryRun) {
        try {
          await client.send(
            new UpdateCommand({
              TableName: table,
              Key: { id },
              UpdateExpression: "SET expiresAt = :until",
              // Re-checked on the server, in case the item changed since the scan.
              ConditionExpression: "attribute_exists(id) AND expiresAt < :until",
              ExpressionAttributeValues: { ":until": until },
            }),
          );
        } catch (error) {
          if ((error as Error).name === "ConditionalCheckFailedException") {
            report.alreadyLater++;
            onItem?.(id, current, "unchanged (changed meanwhile)");
            continue;
          }
          throw error;
        }
      }
      report.extended++;
      onItem?.(id, current, dryRun ? "would extend" : "extended");
    }
    start = page.LastEvaluatedKey;
  } while (start);
  return report;
}
