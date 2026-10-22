// Featured Tonight: admin-chosen stories with a UTC start and end. Stored as ONE item in the existing haunt-stats table
// (key id = "featured#schedule"), so no table or index is needed. Writes are conditional on a version number, so two
// admins can't silently overwrite each other's changes.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const FEATURED_ID = "featured#schedule";
/** How many stories may be featured at once, shown in this order. */
export const MAX_ACTIVE_FEATURED = 3;
/** The schedule keeps at most this many entries (past and future). Older entries are dropped on the next write. */
export const MAX_SCHEDULE_ENTRIES = 20;
/** One selection may run at most this long. */
export const MAX_FEATURE_MS = 14 * 86_400_000;
/** A selection may start at most this far ahead. */
export const MAX_LEAD_MS = 60 * 86_400_000;

const STORY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface FeaturedEntry {
  storyId: string;
  /** ISO 8601, UTC. */
  startsAt: string;
  /** ISO 8601, UTC. Exclusive: the feature stops at this instant. */
  endsAt: string;
}

export type FeatureInput = { storyId: unknown; startsAt: unknown; endsAt: unknown };
export type ValidationResult = { ok: true; entry: FeaturedEntry } | { ok: false; problems: string[] };

/** Checks one selection: a valid story id, a UTC window that ends after it starts, and a sensible length and lead time. */
export function validateFeature(input: FeatureInput, now: number): ValidationResult {
  const problems: string[] = [];
  if (typeof input.storyId !== "string" || !STORY_ID.test(input.storyId)) problems.push("storyId must be a story id.");
  const start = typeof input.startsAt === "string" ? Date.parse(input.startsAt) : NaN;
  const end = typeof input.endsAt === "string" ? Date.parse(input.endsAt) : NaN;
  if (!Number.isFinite(start)) problems.push("startsAt must be a date and time, in UTC (for example 2026-10-22T18:00:00Z).");
  if (!Number.isFinite(end)) problems.push("endsAt must be a date and time, in UTC.");
  if (problems.length === 0) {
    if (end <= start) problems.push("endsAt must be after startsAt.");
    if (end - start > MAX_FEATURE_MS) problems.push("A feature can run for at most 14 days.");
    if (start - now > MAX_LEAD_MS) problems.push("A feature can be scheduled at most 60 days ahead.");
    if (end <= now) problems.push("That feature has already ended.");
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, entry: { storyId: input.storyId as string, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() } };
}

/** The features on air at `now`, in a fixed order: earliest start first, then story id. At most MAX_ACTIVE_FEATURED. */
export function activeFeatured(entries: FeaturedEntry[], now: number): FeaturedEntry[] {
  return entries
    .filter((e) => Date.parse(e.startsAt) <= now && now < Date.parse(e.endsAt))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0))
    .slice(0, MAX_ACTIVE_FEATURED);
}

/** Adds or replaces the selection for a story, then drops the oldest finished entries if the schedule is full. */
export function upsertFeature(entries: FeaturedEntry[], entry: FeaturedEntry, now: number): FeaturedEntry[] {
  const kept = entries.filter((e) => e.storyId !== entry.storyId);
  const next = [...kept, entry].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0));
  if (next.length <= MAX_SCHEDULE_ENTRIES) return next;
  const finished = next.filter((e) => Date.parse(e.endsAt) <= now);
  const drop = new Set(finished.slice(0, next.length - MAX_SCHEDULE_ENTRIES).map((e) => e.storyId + e.startsAt));
  return next.filter((e) => !drop.has(e.storyId + e.startsAt));
}

export function removeFeature(entries: FeaturedEntry[], storyId: string): FeaturedEntry[] {
  return entries.filter((e) => e.storyId !== storyId);
}

export class FeatureVersionError extends Error {
  constructor() {
    super("The schedule changed while you were editing it. Reload it and try again.");
    this.name = "FeatureVersionError";
  }
}

/** Reads and writes the schedule item. `version` is 0 when the item doesn't exist yet. */
export interface FeaturedStore {
  read(): Promise<{ entries: FeaturedEntry[]; version: number }>;
  write(entries: FeaturedEntry[], expectedVersion: number, now: number): Promise<number>;
}

export function dynamoFeaturedStore(client: Pick<DynamoDBDocumentClient, "send">, table: string): FeaturedStore {
  return {
    async read() {
      const { Item } = await client.send(new GetCommand({ TableName: table, Key: { id: FEATURED_ID }, ConsistentRead: true }));
      return { entries: Array.isArray(Item?.entries) ? (Item!.entries as FeaturedEntry[]) : [], version: Number(Item?.version ?? 0) };
    },
    async write(entries, expectedVersion, now) {
      const version = expectedVersion + 1;
      try {
        await client.send(
          new PutCommand({
            TableName: table,
            Item: { id: FEATURED_ID, entries, version, updatedAt: new Date(now).toISOString() },
            // Only write if nobody changed the schedule since it was read.
            ConditionExpression: expectedVersion === 0 ? "attribute_not_exists(id)" : "#v = :expected",
            ExpressionAttributeNames: expectedVersion === 0 ? undefined : { "#v": "version" },
            ExpressionAttributeValues: expectedVersion === 0 ? undefined : { ":expected": expectedVersion },
          }),
        );
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException || (error as Error).name === "ConditionalCheckFailedException") throw new FeatureVersionError();
        throw error;
      }
      return version;
    },
  };
}
