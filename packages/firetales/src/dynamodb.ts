import { GetCommand, PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient, type PutCommandInput } from "@aws-sdk/lib-dynamodb";
import { StoryStateError } from "./engine.ts";
import type { StoryStore } from "./storage.ts";
import type { Story } from "./types.ts";

export interface DynamoStoreOptions {
  /** A DynamoDB document client, e.g. `DynamoDBDocumentClient.from(new DynamoDBClient({}))`. */
  client: Pick<DynamoDBDocumentClient, "send">;
  table: string;
  /** Name of the table's partition key (a string). Defaults to "id". */
  keyAttribute?: string;
  /** Prefix for keys, so stories can share a table with other records. Defaults to "story#". */
  keyPrefix?: string;
  /**
   * Delete stories this long after their last update, using DynamoDB's TTL on the
   * `expiresAt` attribute (enable TTL on the table for it to take effect). Off when unset.
   */
  ttlSeconds?: number;
  /**
   * A global secondary index with partition key `ownerId` and sort key `updatedAt`, for
   * listing one owner's stories without a scan. Without it, `listByOwner` scans.
   */
  ownerIndex?: string;
  /** For tests. */
  now?: () => Date;
}

/** Another server instance saved this story after we read it. */
export class StoryConflictError extends StoryStateError {
  constructor() {
    super("This story was just changed somewhere else. Please try that again.");
    this.name = "StoryConflictError";
  }
}

const KNOWN_VERSIONS_LIMIT = 5_000;

/**
 * Stores each story as one DynamoDB item. Stories stay well under the 400 KB item limit
 * (a long story is about 30 KB). `list()` scans, which is fine for small tables.
 *
 * Writes are conditional on the version this instance last read or wrote, so two server
 * instances can never silently overwrite each other's turns: the second one gets a
 * StoryConflictError instead. Items written before versioning (no `version`) are accepted
 * once and versioned from then on.
 */
export class DynamoStore implements StoryStore {
  readonly #client: DynamoStoreOptions["client"];
  readonly #table: string;
  readonly #key: string;
  readonly #prefix: string;
  readonly #ttlSeconds: number | undefined;
  readonly #ownerIndex: string | undefined;
  readonly #now: () => Date;
  /** Version of each story as this instance last saw it. */
  readonly #versions = new Map<string, number>();

  constructor(options: DynamoStoreOptions) {
    this.#client = options.client;
    this.#table = options.table;
    this.#key = options.keyAttribute ?? "id";
    this.#prefix = options.keyPrefix ?? "story#";
    this.#ttlSeconds = options.ttlSeconds && options.ttlSeconds > 0 ? options.ttlSeconds : undefined;
    this.#ownerIndex = options.ownerIndex || undefined;
    this.#now = options.now ?? (() => new Date());
  }

  async get(id: string): Promise<Story | undefined> {
    const { Item } = await this.#client.send(
      new GetCommand({ TableName: this.#table, Key: { [this.#key]: this.#prefix + id }, ConsistentRead: true }),
    );
    if (!Item) return undefined;
    this.#remember(id, typeof Item.version === "number" ? Item.version : 0);
    return Item.story as Story;
  }

  async put(story: Story): Promise<void> {
    const expected = this.#versions.get(story.id);
    const next = (expected ?? 0) + 1;
    // New story, an unversioned legacy item, or exactly the version we read. DynamoDB rejects
    // attribute names or values that the expression doesn't use, so each case declares its own.
    const condition: Pick<PutCommandInput, "ConditionExpression" | "ExpressionAttributeNames" | "ExpressionAttributeValues"> =
      expected === undefined
        ? { ConditionExpression: "attribute_not_exists(#key)", ExpressionAttributeNames: { "#key": this.#key } }
        : expected === 0
          ? {
              ConditionExpression: "attribute_not_exists(#key) OR attribute_not_exists(#version) OR #version = :expected",
              ExpressionAttributeNames: { "#key": this.#key, "#version": "version" },
              ExpressionAttributeValues: { ":expected": expected },
            }
          : {
              ConditionExpression: "#version = :expected",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: { ":expected": expected },
            };
    try {
      await this.#client.send(new PutCommand({ TableName: this.#table, Item: this.#item(story, next), ...condition }));
    } catch (error) {
      if ((error as Error).name === "ConditionalCheckFailedException") {
        this.#versions.delete(story.id);
        throw new StoryConflictError();
      }
      throw error;
    }
    this.#remember(story.id, next);
  }

  /** Writes a story only if no item with its id exists. Returns false when one already did. Used by migrations. */
  async putIfAbsent(story: Story): Promise<boolean> {
    try {
      await this.#client.send(
        new PutCommand({
          TableName: this.#table,
          Item: this.#item(story, 1),
          ConditionExpression: "attribute_not_exists(#key)",
          ExpressionAttributeNames: { "#key": this.#key },
        }),
      );
      return true;
    } catch (error) {
      if ((error as Error).name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async listByOwner(ownerId: string): Promise<Story[]> {
    if (!this.#ownerIndex) return this.#scan({ "#owner": "ownerId" }, { ":owner": ownerId }, "#owner = :owner");
    const stories: Story[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.#client.send(
        new QueryCommand({
          TableName: this.#table,
          IndexName: this.#ownerIndex,
          KeyConditionExpression: "#owner = :owner",
          // The index may also hold other record types one day; keep stories only.
          FilterExpression: "begins_with(#key, :prefix)",
          ExpressionAttributeNames: { "#owner": "ownerId", "#key": this.#key },
          ExpressionAttributeValues: { ":owner": ownerId, ":prefix": this.#prefix },
          ScanIndexForward: false,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) stories.push(item.story as Story);
      start = page.LastEvaluatedKey;
    } while (start);
    return stories;
  }

  async list(): Promise<Story[]> {
    return this.#scan();
  }

  async #scan(names: Record<string, string> = {}, values: Record<string, unknown> = {}, extra?: string): Promise<Story[]> {
    const stories: Story[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.#client.send(
        new ScanCommand({
          TableName: this.#table,
          FilterExpression: `begins_with(#key, :prefix)${extra ? ` AND ${extra}` : ""}`,
          ExpressionAttributeNames: { "#key": this.#key, ...names },
          ExpressionAttributeValues: { ":prefix": this.#prefix, ...values },
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) stories.push(item.story as Story);
      start = page.LastEvaluatedKey;
    } while (start);
    return stories;
  }

  #item(story: Story, version: number) {
    return {
      [this.#key]: this.#prefix + story.id,
      story,
      status: story.status,
      updatedAt: story.updatedAt,
      // Top-level copies so an index can find a listener's stories, or the review queue.
      ...(story.ownerId ? { ownerId: story.ownerId } : {}),
      ...(story.review ? { reviewStatus: story.review.status } : {}),
      version,
      ...(this.#ttlSeconds ? { expiresAt: Math.floor(this.#now().getTime() / 1000) + this.#ttlSeconds } : {}),
    };
  }

  #remember(id: string, version: number) {
    this.#versions.delete(id);
    this.#versions.set(id, version);
    // Oldest first: forgetting a version only means the next write re-reads it as a conflict.
    if (this.#versions.size > KNOWN_VERSIONS_LIMIT) this.#versions.delete(this.#versions.keys().next().value!);
  }
}
