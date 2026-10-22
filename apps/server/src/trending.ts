// Trending: ranks stories by recent playback. Pure ranking plus a bounded DynamoDB reader.
//
// Data: the existing playback records in the stats table, one per (story, playId), written by engagement.ts with a
// `playedAt` time. The playId makes each record idempotent, so a retried request can't add a second play.
//
// Reading recent records needs a time-based index. The stats table keys on `id` alone, so a time query would be a scan,
// which this module never does. `recentPlays` queries a global secondary index named TREND_INDEX, keyed by the day of
// each play (`trendDay`). That index does not exist yet (Phase 2 adds it, with the write that sets `trendDay`).
// Until then the DynamoDB reader is not wired into any route.

import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const TREND_INDEX = "trend-by-day";
/** Plays older than this are ignored entirely. */
export const TREND_WINDOW_DAYS = 7;
/** A play loses half its weight after this many hours. */
export const TREND_HALF_LIFE_HOURS = 72;
/** Most records read per day, and per ranking. Reads stop there and the result says it was truncated. */
export const MAX_EVENTS_PER_DAY = 2000;
export const MAX_EVENTS = 10_000;

export interface PlayRecord {
  storyId: string;
  playId: string;
  /** ISO time the play started, as written by the playback route. */
  playedAt: string;
}

export interface RankedStory {
  storyId: string;
  /** Weighted plays. Recent plays count more; the number is relative, not a play count. */
  score: number;
  /** Plays inside the window, after removing repeats of the same playId. */
  plays: number;
}

export interface RankingResult {
  stories: RankedStory[];
  /** True when a read stopped at its cap, so the ranking covers only part of the window. */
  truncated: boolean;
}

const PLAY_ID = /^[A-Za-z0-9-]{8,64}$/;
const STORY_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The playId of a play record. The record's key is "play#<storyId>#<playId>", and the record has no playId attribute,
 * so the key is the source. Undefined when the key doesn't have that shape.
 */
export function playIdFromKey(key: string, storyId: string): string | undefined {
  const prefix = `play#${storyId}#`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

/** A record is usable only with a valid story id, a valid playId and a real time. */
export function isUsablePlay(record: PlayRecord): boolean {
  return STORY_ID.test(record.storyId) && PLAY_ID.test(record.playId) && Number.isFinite(Date.parse(record.playedAt));
}

/** Weight of one play that started `ageMs` ago. 1 when it's now, half after one half-life, never negative. */
export function playWeight(ageMs: number, halfLifeHours = TREND_HALF_LIFE_HOURS): number {
  const hours = Math.max(0, ageMs) / 3_600_000;
  return Math.pow(0.5, hours / halfLifeHours);
}

/**
 * Ranks stories by weighted recent plays.
 *  - Plays with an invalid id or time are ignored.
 *  - Repeated (storyId, playId) pairs count once, however many times they were read.
 *  - Plays in the future, or older than the window, are ignored.
 *  - Ties on score are broken by plays, then storyId ascending, so the order is always the same.
 */
export function rankTrending(
  records: PlayRecord[],
  options: { now: number; limit: number; windowDays?: number; halfLifeHours?: number },
): RankedStory[] {
  const windowMs = (options.windowDays ?? TREND_WINDOW_DAYS) * 86_400_000;
  const seen = new Set<string>();
  const totals = new Map<string, { score: number; plays: number }>();
  for (const record of records) {
    if (!isUsablePlay(record)) continue;
    const key = `${record.storyId}\u0000${record.playId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const age = options.now - Date.parse(record.playedAt);
    if (age < 0 || age > windowMs) continue;
    const entry = totals.get(record.storyId) ?? { score: 0, plays: 0 };
    entry.score += playWeight(age, options.halfLifeHours);
    entry.plays += 1;
    totals.set(record.storyId, entry);
  }
  return [...totals.entries()]
    .map(([storyId, { score, plays }]) => ({ storyId, score, plays }))
    .sort((a, b) => b.score - a.score || b.plays - a.plays || (a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0))
    .slice(0, Math.max(0, options.limit));
}

/** The day a play belongs to, in UTC ("2026-10-22"). Used as the index key so each day is its own partition. */
export function trendDayOf(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** The UTC days covered by the window ending at `now`, oldest first. */
export function windowDays(now: number, days = TREND_WINDOW_DAYS): string[] {
  return Array.from({ length: days }, (_, i) => trendDayOf(new Date(now - (days - 1 - i) * 86_400_000).toISOString()));
}

/** Reads recent play records. Injected so the ranking can be tested without DynamoDB. */
export interface PlaySource {
  recentPlays(now: number): Promise<{ records: PlayRecord[]; truncated: boolean }>;
}

/**
 * Reads the window's play records from the TREND_INDEX index, one query per day, each bounded. Any DynamoDB error is
 * thrown, not swallowed, so a caller can show an error rather than an empty ranking.
 */
export function dynamoPlaySource(client: Pick<DynamoDBDocumentClient, "send">, table: string): PlaySource {
  return {
    async recentPlays(now) {
      const records: PlayRecord[] = [];
      let truncated = false;
      for (const day of windowDays(now)) {
        let startKey: Record<string, unknown> | undefined;
        let readThisDay = 0;
        do {
          const page = await client.send(
            new QueryCommand({
              TableName: table,
              IndexName: TREND_INDEX,
              KeyConditionExpression: "#day = :day",
              ExpressionAttributeNames: { "#day": "trendDay" },
              ExpressionAttributeValues: { ":day": day },
              Limit: Math.min(MAX_EVENTS_PER_DAY - readThisDay, 500),
              ExclusiveStartKey: startKey,
              ProjectionExpression: "id, storyId, playedAt",
            }),
          );
          for (const item of page.Items ?? []) {
            const storyId = String(item.storyId ?? "");
            const playId = playIdFromKey(String(item.id ?? ""), storyId);
            // A record without a usable playId or story id is skipped; rankTrending would drop it anyway.
            if (playId !== undefined) records.push({ storyId, playId, playedAt: String(item.playedAt ?? "") });
          }
          readThisDay += page.Items?.length ?? 0;
          startKey = page.LastEvaluatedKey;
          if (startKey && readThisDay >= MAX_EVENTS_PER_DAY) {
            truncated = true;
            break;
          }
          if (records.length >= MAX_EVENTS) {
            truncated = true;
            return { records, truncated };
          }
        } while (startKey);
      }
      return { records, truncated };
    },
  };
}

/** The trending list: reads recent plays from the source, ranks them, and reports whether the read was complete. */
export async function trendingStories(
  source: PlaySource,
  options: { now: number; limit: number },
): Promise<RankingResult> {
  const { records, truncated } = await source.recentPlays(options.now);
  return { stories: rankTrending(records, { now: options.now, limit: options.limit }), truncated };
}
