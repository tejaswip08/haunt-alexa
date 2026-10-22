import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/**
 * Likes and progress in their own tables, keyed the same way: partition key `userId` (the verified Cognito `sub`), sort key
 * `hauntId` (the story id). One item per user per story, so nothing grows with the number of stories a user has touched.
 *
 *   haunt-likes     { userId, hauntId, liked, createdAt, updatedAt }   `liked: false` is kept as a tombstone (see setLike)
 *   haunt-progress  { userId, hauntId, partIndex, totalParts, positionMs, completed, lastPlayedAt, mode?, segment?, history? }
 *
 * Rollout (HAUNT_RECORDS=dual): reads prefer the new tables and fall back to the legacy maps in `haunt-users` for a story
 * with no new record; writes go to the new tables only. Where both sources have a record, the one that is newer wins
 * (progress by lastPlayedAt, a like by its updatedAt versus the legacy likedAt); ties go to the new record. Legacy data is never
 * rewritten here, so it stays intact until the migration has been verified.
 */

export type RecordsMode = "legacy" | "dual";

export interface LikeRecord {
  userId: string;
  hauntId: string;
  liked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProgressRecord {
  userId: string;
  hauntId: string;
  partIndex: number;
  totalParts: number;
  positionMs: number;
  completed: boolean;
  lastPlayedAt: string;
  completedAt?: string;
  mode?: "choices" | "listen";
  segment?: number;
  history?: number[];
  /** Counts the saves that the record has accepted. Absent on records written before versions existed (read as 0). */
  version?: number;
}

/** Bounds one account read to 40 pages of 100 items (4,000 records). Reaching the bound is an error, never a short result. */
const MAX_PAGES = 40;
const PAGE = 100;

/** Thrown when a query has more records than the read is allowed to return. Names the table, never the user. */
export class QueryLimitError extends Error {
  constructor(readonly table: string, readonly limit: number) {
    super(`Query on ${table} has more than ${limit} records; the read was stopped rather than returning a partial list.`);
    this.name = "QueryLimitError";
  }
}

export class SplitStore {
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly tables: { likes: string; progress: string; stories: string; stats: string },
    /** Reads the legacy `likes` map ({ storyId: likedAt }) for the same user, used only to decide a like with no new record. */
    private readonly legacyLikes: (userId: string) => Promise<Record<string, string>>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Every record for one user in one table, paged. Always a Query on `userId`; never a scan. */
  private async allFor<T>(table: string, userId: string): Promise<T[]> {
    const items: T[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const out = await this.client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "userId = :u",
          ExpressionAttributeValues: { ":u": userId },
          ConsistentRead: true,
          Limit: PAGE,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((out.Items ?? []) as T[]));
      if (!out.LastEvaluatedKey) return items;
      startKey = out.LastEvaluatedKey;
    }
    // More records remain than the page limit allows. Failing here is deliberate: returning what was read would silently
    // drop likes or progress. The message names the table only; no user data is included.
    throw new QueryLimitError(table, MAX_PAGES * PAGE);
  }

  /** The user's new-table like records, including tombstones (liked: false). */
  likeRecords(userId: string): Promise<LikeRecord[]> {
    return this.allFor<LikeRecord>(this.tables.likes, userId);
  }

  /** The user's new-table progress records, one per story. */
  progressRecords(userId: string): Promise<ProgressRecord[]> {
    return this.allFor<ProgressRecord>(this.tables.progress, userId);
  }

  /**
   * Whether this user likes the story. A new record decides; with none, the legacy answer (the like# item) is used, so an
   * unlike recorded in the new table is never overridden by the old one.
   */
  async liked(userId: string, storyId: string, legacy: () => Promise<boolean>): Promise<boolean> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tables.likes, Key: { userId, hauntId: storyId }, ConsistentRead: true }));
    if (Item) return Boolean((Item as LikeRecord).liked);
    return legacy();
  }

  /**
   * Sets one user's like. Idempotent: setting the state it already has changes nothing and counts nothing. The like record
   * and the story's total change in one transaction. The conditions make a concurrent or repeated request either succeed
   * once or do nothing: a second request finds the state already set and changes nothing further.
   *
   * An unlike of a story liked only in the legacy map writes a tombstone (liked: false), so the new table, which takes
   * precedence, reports it as not liked.
   */
  async setLike(userId: string, storyId: string, liked: boolean): Promise<{ changed: boolean; liked: boolean }> {
    const key = { userId, hauntId: storyId };
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tables.likes, Key: key, ConsistentRead: true }));
    const current = Item as LikeRecord | undefined;
    const legacy = current ? undefined : (await this.legacyLikes(userId))[storyId];
    const was = current ? current.liked : legacy !== undefined;
    if (was === liked) return { changed: false, liked };

    const stamp = this.now().toISOString();
    const record: LikeRecord = { userId, hauntId: storyId, liked, createdAt: current?.createdAt ?? legacy ?? stamp, updatedAt: stamp };
    // The like record must still be in the state read above when the transaction applies: a concurrent change cancels it.
    const condition = current
      ? { ConditionExpression: "liked = :was", ExpressionAttributeValues: { ":was": current.liked } }
      : { ConditionExpression: "attribute_not_exists(hauntId)" };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.tables.likes, Item: record, ...condition } },
            {
              Update: {
                TableName: this.tables.stats,
                Key: { id: `stat#${storyId}` },
                UpdateExpression: "ADD likes :delta",
                // Never below zero: a total only drops by a like that was really counted.
                ...(liked ? {} : { ConditionExpression: "likes >= :one" }),
                ExpressionAttributeValues: liked ? { ":delta": 1 } : { ":delta": -1, ":one": 1 },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        const again = await this.client.send(new GetCommand({ TableName: this.tables.likes, Key: key, ConsistentRead: true }));
        const state = again.Item ? (again.Item as LikeRecord).liked : was;
        return { changed: false, liked: state };
      }
      throw error;
    }
    return { changed: true, liked };
  }

  /**
   * Saves progress with stale-update protection. A write applies only if the stored record is missing, or it is older, or it
   * has the same lastPlayedAt and does not move the listener back to an earlier part. A rejected write changes nothing and
   * reports the record that is stored.
   */
  /**
   * Writes one checkpoint. With `expectedVersion`, the write happens only if the stored version is still that one: the check
   * and the write are one atomic DynamoDB condition, so a delayed save that was based on older progress is refused, whatever
   * its timestamp. Without it, the write keeps the timestamp rule (the server stamps lastPlayedAt, so this is last writer wins).
   */
  async saveProgress(
    record: ProgressRecord,
    expectedVersion?: number,
  ): Promise<{ applied: boolean; current?: ProgressRecord }> {
    const key = { userId: record.userId, hauntId: record.hauntId };
    try {
      if (expectedVersion !== undefined) {
        await this.client.send(
          new PutCommand({
            TableName: this.tables.progress,
            // 0 means "no version yet": a new record, or one written before versions existed.
            Item: { ...record, version: expectedVersion + 1 },
            ConditionExpression: expectedVersion === 0 ? "attribute_not_exists(version)" : "version = :e",
            ...(expectedVersion === 0 ? {} : { ExpressionAttributeValues: { ":e": expectedVersion } }),
          }),
        );
        return { applied: true };
      }
      await this.client.send(
        new PutCommand({
          TableName: this.tables.progress,
          Item: record,
          ConditionExpression:
            "attribute_not_exists(hauntId) OR lastPlayedAt < :t OR (lastPlayedAt = :t AND partIndex <= :p)",
          ExpressionAttributeValues: { ":t": record.lastPlayedAt, ":p": record.partIndex },
        }),
      );
      return { applied: true };
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
      const { Item } = await this.client.send(new GetCommand({ TableName: this.tables.progress, Key: key, ConsistentRead: true }));
      return { applied: false, current: Item as ProgressRecord | undefined };
    }
  }
}

/** A conditional write that the condition rejected (the request was not applied). */
export function isConditionFailure(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e?.name === "ConditionalCheckFailedException") return true;
  return e?.name === "TransactionCanceledException" && (e.CancellationReasons ?? []).some((r) => r.Code === "ConditionalCheckFailed");
}

/**
 * Picks the progress for one story from the two sources. The newer lastPlayedAt wins. A tie goes to the new record. A missing
 * side is simply absent.
 */
export function newerProgress<T extends { lastPlayedAt: string }>(fresh: T | undefined, legacy: T | undefined): T | undefined {
  if (!fresh) return legacy;
  if (!legacy) return fresh;
  return legacy.lastPlayedAt > fresh.lastPlayedAt ? legacy : fresh;
}
