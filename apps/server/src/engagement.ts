import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { dynamo } from "./stories.ts";
import { config } from "./config.ts";
import { libraryKey } from "./viewing.ts";

/**
 * Likes and play counts, kept in the stories table beside the stories (no new table):
 *
 *   stat#<storyId>           { likes, plays }   the totals. Only ADD changes them, in the same transaction as each change.
 *   like#<storyId>#<userId>  legacy, read-only. Likes are written to haunt-likes (see split-records.ts); these items are only read as a fallback.
 *   play#<storyId>#<playId>  one item per recorded playback start. The client's playId makes retries idempotent.
 *
 * None of these items gets `expiresAt`, so the story TTL (HAUNT_STORY_TTL_DAYS) never applies to them. Their keys don't
 * start with `story#`, so story listings (which filter on that prefix) never see them.
 */
export interface Counts {
  likes: number;
  plays: number;
}

const statKey = (storyId: string) => `stat#${storyId}`;
const likeKey = (storyId: string, userId: string) => `like#${storyId}#${userId}`;
const playKey = (storyId: string, playId: string) => `play#${storyId}#${playId}`;

/** A transaction failed because the item at `index` didn't meet its condition (for example, the like already exists). */
function conditionFailedAt(error: unknown, index: number): boolean {
  const reasons = (error as { CancellationReasons?: { Code?: string }[] } | undefined)?.CancellationReasons;
  return (error as { name?: string })?.name === "TransactionCanceledException" && reasons?.[index]?.Code === "ConditionalCheckFailed";
}

export class EngagementStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string,
    /** The listeners' table: each like is mirrored into the listener's viewing record in the same transaction. */
    private readonly usersTable?: string,
    /** Where stat# totals and play# records live. */
    private readonly statsTable: string = table,
  ) {}

  async counts(storyId: string): Promise<Counts> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.statsTable, Key: { id: statKey(storyId) }, ConsistentRead: true }));
    return { likes: Number(Item?.likes ?? 0), plays: Number(Item?.plays ?? 0) };
  }

  async liked(storyId: string, userId: string): Promise<boolean> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.table, Key: { id: likeKey(storyId, userId) }, ConsistentRead: true }),
    );
    return Boolean(Item);
  }


  /** Creates the record's likes map when it's missing, so the like can be written into it. Safe to repeat. */

  /**
   * Records one playback start. The playId is chosen by the client once per playback session, so a retry or a
   * duplicate request with the same id is ignored (`counted: false`).
   */
  async recordPlay(storyId: string, playId: string): Promise<{ counted: boolean } & Counts> {
    const playedAt = new Date().toISOString();
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.statsTable,
                // trendDay is the UTC day of playedAt. The trend-by-day index (trending.ts) reads it; plays written before it
                // existed have no trendDay and are not in the index until backfilled.
                Item: { id: playKey(storyId, playId), storyId, playedAt: playedAt, trendDay: playedAt.slice(0, 10) },
                ConditionExpression: "attribute_not_exists(id)",
              },
            },
            { Update: { TableName: this.statsTable, Key: { id: statKey(storyId) }, UpdateExpression: "ADD plays :one", ExpressionAttributeValues: { ":one": 1 } } },
          ],
        }),
      );
      return { counted: true, ...(await this.counts(storyId)) };
    } catch (error) {
      if (!conditionFailedAt(error, 0)) throw error;
      return { counted: false, ...(await this.counts(storyId)) };
    }
  }
}

/** The shared engagement store on the DynamoDB backend. Undefined in development (no database). */
export const engagement = dynamo && config.store === "dynamodb" ? new EngagementStore(dynamo, config.table, config.usersTable, config.statsTable) : undefined;
