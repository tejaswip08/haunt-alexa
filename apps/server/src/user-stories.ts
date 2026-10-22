import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mainPath, SUBGENRE_IDS, type Episode, type EpisodeSegment } from "@firetales/core";
import { isConditionFailure } from "./split-records.ts";
import { COVER_PATH_SOURCE } from "./covers.ts";

/**
 * A listener's own stories (My Stories) in `haunt-user-stories`. One record per story: key userId (HASH, from the verified
 * session) and hauntId (RANGE, generated here). Published records also carry `publishedKey` ("published") and `publishedAt`,
 * which the `published-by-date` index uses for Community. Drafts have neither, so they are never listed publicly.
 *
 * The story body uses the canonical playable format: segments in an Episode, zero-based. A segment's sceneIndex is its
 * position in the array, the same convention as library stories.
 */

const MoodSchema = z.enum(["calm", "uneasy", "suspense", "exploration", "threat", "revelation", "ending"]);
const SEGMENT_LIMIT = 60;

const SegmentSchema = z.object({
  sceneIndex: z.number().int().min(0).max(SEGMENT_LIMIT - 1),
  narration: z.string().trim().min(1, "Every scene needs narration.").max(4000),
  mood: MoodSchema.default("calm"),
  soundCues: z.array(z.string().trim().max(80)).max(8).default([]),
  visualPrompt: z.string().trim().max(400).default(""),
  choices: z
    .object({
      prompt: z.string().trim().min(1).max(300),
      options: z
        .array(z.object({ label: z.string().trim().min(1).max(120), next: z.number().int().min(0).max(SEGMENT_LIMIT - 1) }))
        .min(1)
        .max(4),
    })
    .optional(),
  next: z.number().int().min(0).max(SEGMENT_LIMIT - 1).optional(),
  ending: z.boolean().optional(),
});

/** What the author edits. Everything the story needs to play and to be listed. */
export const StoryInputSchema = z.object({
  title: z.string().trim().min(1, "A title is required.").max(120),
  synopsis: z.string().trim().max(600).default(""),
  premise: z.string().trim().max(500).default(""),
  genre: z.string().trim().max(60).default(""),
  atmosphere: z.string().trim().max(120).default(""),
  /** Pen name shown in Community. Never the listener's account name or email. */
  author: z.string().trim().min(1, "An author name is required.").max(60),
  /** Cover artwork reference: an https URL to an image, an upload made through /cover, or empty for none. */
  coverUrl: z
    .string()
    .trim()
    .max(500)
    .regex(new RegExp(`^(https:\\/\\/[^\\s]+|${COVER_PATH_SOURCE})?$`), "The cover must be an https:// link or an uploaded image.")
    .default(""),
  segments: z.array(SegmentSchema).min(1, "Add at least one scene.").max(SEGMENT_LIMIT),
  /** The Create settings this draft was generated from, so Edit can preload them. Absent for hand-written stories. */
  settings: z
    .object({
      subgenre: z.enum(SUBGENRE_IDS),
      length: z.enum(["short", "standard", "epic"]),
      fear: z.enum(["eerie", "scary", "terrifying"]),
      language: z.string().trim().min(2).max(16),
      idea: z.string().trim().max(200).default(""),
    })
    .optional(),
});
export type StoryInput = z.infer<typeof StoryInputSchema>;

export interface UserStoryRecord {
  userId: string;
  hauntId: string;
  status: "draft" | "published";
  /** Increments on every accepted write. Writes must name the version they are based on. */
  version: number;
  /** The creator's working revision. It is public only after an admin approves it (see publicStory). */
  story: StoryInput;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  publishedKey?: "published";
  /**
   * The approved revision that Community shows. Written only by approval (story-approvals.ts), in the same transaction that
   * lists the story, and copied from the working revision that was reviewed. A story published before this field existed has none;
   * its public revision is then its working revision (see publicRevisionOf).
   */
  publicStory?: PublicRevision;
}

export interface PublicRevision {
  story: StoryInput;
  version: number;
  approvedAt: string;
  /** Set when the public copy was saved from a story published before approval records existed (see update). */
  grandfathered?: true;
}

/** Largest working revision that can be kept as a public copy next to the newer one (DynamoDB items are capped at 400 KB). */
export const MAX_PUBLIC_STORY_BYTES = 150_000;
export function storyFits(story: StoryInput): boolean {
  return Buffer.byteLength(JSON.stringify(story), "utf8") <= MAX_PUBLIC_STORY_BYTES;
}

/**
 * The revision Community shows for a published story: its approved snapshot. A story published before snapshots existed (no
 * snapshot, but listed) shows its working revision, as it always has. legacy is true only for that fallback.
 */
export function publicRevisionOf(record: UserStoryRecord): (PublicRevision & { legacy?: true }) | undefined {
  if (record.publicStory) return record.publicStory;
  if (record.publishedKey !== "published") return undefined;
  return { story: record.story, version: record.version, approvedAt: record.publishedAt ?? record.updatedAt, legacy: true };
}

export class UserStoryError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid" | "not_draft",
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "UserStoryError";
  }
}

/**
 * Checks the scene graph before publish (and reports the same problems in preview). Returns human-readable problems; an
 * empty list means the story can play from its first scene to an ending. Pure, so the same rules apply everywhere.
 */
export function validateSegments(segments: StoryInput["segments"]): string[] {
  const problems: string[] = [];
  const n = segments.length;
  if (n === 0) return ["Add at least one scene."];
  segments.forEach((segment, i) => {
    if (segment.sceneIndex !== i) {
      problems.push(`Scene ${i} has sceneIndex ${segment.sceneIndex}. Scene indexes start at 0 and must match the scene's position.`);
    }
    if (segment.choices && segment.ending) problems.push(`Scene ${i} is an ending, so it can't also ask a choice.`);
    for (const option of segment.choices?.options ?? []) {
      if (option.next >= n) problems.push(`Scene ${i} has a choice that leads to scene ${option.next}, which doesn't exist.`);
    }
    if (!segment.choices && !segment.ending && segment.next !== undefined && segment.next >= n) {
      problems.push(`Scene ${i} continues to scene ${segment.next}, which doesn't exist.`);
    }
  });
  if (problems.length > 0) return problems;

  const edges = (i: number): number[] => {
    const s = segments[i]!;
    if (s.ending) return [];
    if (s.choices) return s.choices.options.map((o) => o.next);
    const next = s.next ?? i + 1;
    return next < n ? [next] : [];
  };
  // Forward reachability from the first scene.
  const reachable = new Set<number>([0]);
  const queue = [0];
  while (queue.length) {
    for (const to of edges(queue.shift()!)) {
      if (!reachable.has(to)) {
        reachable.add(to);
        queue.push(to);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (!reachable.has(i)) problems.push(`Scene ${i} can't be reached from the first scene.`);
  }
  // Backward reachability from the endings: every reachable scene must still be able to reach one (no dead ends, no loops
  // with no way out).
  const reverse = Array.from({ length: n }, () => [] as number[]);
  for (let i = 0; i < n; i++) for (const to of edges(i)) reverse[to]!.push(i);
  const canEnd = new Set<number>();
  const back = segments.flatMap((s, i) => (s.ending ? [i] : []));
  back.forEach((i) => canEnd.add(i));
  const pending = [...back];
  while (pending.length) {
    for (const from of reverse[pending.shift()!]!) {
      if (!canEnd.has(from)) {
        canEnd.add(from);
        pending.push(from);
      }
    }
  }
  if (back.length === 0) problems.push("The story needs at least one ending.");
  for (const i of reachable) {
    if (!canEnd.has(i)) problems.push(`Scene ${i} has no way to reach an ending. Add a choice or an ending after it.`);
  }
  // A non-ending scene with nothing after it is an accidental dead end.
  for (let i = 0; i < n; i++) {
    if (reachable.has(i) && edges(i).length === 0 && !segments[i]!.ending) {
      problems.push(`Scene ${i} ends the story without being marked as an ending.`);
    }
  }
  return problems;
}

/** The story as the playable Episode format, built from the draft, so preview plays exactly what would be published. */
export function episodeFor(hauntId: string, input: StoryInput): Episode {
  const segments: EpisodeSegment[] = input.segments.map((s) => ({
    sceneIndex: s.sceneIndex,
    narration: s.narration.trim(),
    mood: s.mood,
    soundCues: s.soundCues,
    visualPrompt: s.visualPrompt,
    ...(s.choices ? { choices: s.choices } : {}),
    ...(s.next !== undefined ? { next: s.next } : {}),
    ...(s.ending ? { ending: true } : {}),
  }));
  const script = segments.map((s) => s.narration).join("\n\n");
  const wordCount = script.split(/\s+/).filter(Boolean).length;
  return {
    storyId: hauntId,
    title: input.title,
    premise: input.premise,
    language: "en",
    segments,
    script,
    wordCount,
    estimatedMinutes: Math.max(1, Math.round(wordCount / 150)),
  };
}

/** An episode with the author's pen name, so the player can credit it. */
export type PlayableEpisode = Episode & { creator: string };

/**
 * The pen name a story is credited to. It comes only from the stored record (the author typed it when saving), never from
 * the request, and never from an account id or profile field. Empty when the author left it blank.
 */
export function creatorOf(record: UserStoryRecord): string {
  return (publicRevisionOf(record)?.story ?? record.story).author.trim();
}

/** Public card for Community: no account identifiers, only what an author chose to show. */
export interface CommunityCard {
  id: string;
  title: string;
  synopsis: string;
  author: string;
  genre: string;
  atmosphere: string;
  coverUrl: string;
  publishedAt: string;
  minutes: number;
}

export function communityCard(record: UserStoryRecord): CommunityCard {
  const pub = publicRevisionOf(record)?.story ?? record.story;
  const episode = episodeFor(record.hauntId, pub);
  return {
    id: record.hauntId,
    title: pub.title,
    synopsis: pub.synopsis,
    author: pub.author,
    genre: pub.genre,
    atmosphere: pub.atmosphere,
    coverUrl: pub.coverUrl,
    publishedAt: record.publishedAt ?? record.updatedAt,
    minutes: episode.estimatedMinutes,
  };
}

const TABLE_LIMIT_PAGES = 40;
const PAGE = 100;

/** Thrown when a read would have to return a partial list. Names the table, never the user. */
export class UserStoryQueryLimitError extends Error {
  constructor(readonly table: string) {
    super(`Query on ${table} has more records than one read can return; the list was not shown partly.`);
    this.name = "UserStoryQueryLimitError";
  }
}

export class UserStoryStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Every story of one user, newest first. Paged; an incomplete read is an error, never a short list. */
  async listFor(userId: string): Promise<UserStoryRecord[]> {
    const items: UserStoryRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < TABLE_LIMIT_PAGES; page++) {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "userId = :u",
          ExpressionAttributeValues: { ":u": userId },
          ConsistentRead: true,
          Limit: PAGE,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((out.Items ?? []) as UserStoryRecord[]));
      startKey = out.LastEvaluatedKey;
      if (!startKey) return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    throw new UserStoryQueryLimitError(this.table);
  }

  get(userId: string, hauntId: string): Promise<UserStoryRecord | undefined> {
    return this.client
      .send(new GetCommand({ TableName: this.table, Key: { userId, hauntId }, ConsistentRead: true }))
      .then((out) => out.Item as UserStoryRecord | undefined);
  }

  async create(userId: string, input: StoryInput): Promise<UserStoryRecord> {
    const stamp = this.now();
    const record: UserStoryRecord = {
      userId,
      hauntId: `us_${randomBytes(12).toString("base64url")}`,
      status: "draft",
      version: 1,
      story: input,
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.client.send(
      new PutCommand({ TableName: this.table, Item: record, ConditionExpression: "attribute_not_exists(hauntId)" }),
    );
    return record;
  }

  /**
   * Replaces the story body. `expectedVersion` must match the stored version, so two saves from different tabs can't
   * silently overwrite each other. A published story must stay valid, so an edit that breaks it is refused.
   */
  async update(userId: string, hauntId: string, input: StoryInput, expectedVersion: number): Promise<UserStoryRecord> {
    const current = await this.require(userId, hauntId);
    const stamp = this.now();
    // A published story keeps its approved revision public while this edit is pending review. A story published before
    // snapshots existed gets its current revision saved as the public copy first, so the edit never goes live unreviewed.
    const snapshot = publicRevisionOf(current);
    if (current.publishedKey === "published" && snapshot && !current.publicStory && !storyFits(snapshot.story)) {
      throw new UserStoryError("invalid", "This story is too long to keep published while you edit it. Unpublish it first.", []);
    }
    const next: UserStoryRecord = {
      ...current,
      story: input,
      version: current.version + 1,
      updatedAt: stamp,
      ...(current.publishedKey === "published" && snapshot
        ? {
            publicStory: {
              story: snapshot.story,
              version: snapshot.version,
              approvedAt: snapshot.approvedAt,
              ...((snapshot as { legacy?: true }).legacy ? { grandfathered: true as const } : {}),
            },
          }
        : {}),
    };
    await this.writeIf(next, expectedVersion);
    return next;
  }

  /** Read-only: the validation problems and the episode exactly as it would play. */
  async preview(userId: string, hauntId: string): Promise<{ problems: string[]; episode: PlayableEpisode }> {
    const record = await this.require(userId, hauntId);
    return { problems: validateSegments(record.story.segments), episode: { ...episodeFor(hauntId, record.story), creator: creatorOf(record) } };
  }

  /**
   * Stories become public only through StoryApprovalStore.approve, which sets publishedKey in the same transaction as the
   * approval. There is deliberately no publish method here.
   */

  /** Takes the story off Community. It stays in My Stories as a draft, with its content and publish date. */
  async unpublish(userId: string, hauntId: string, expectedVersion: number): Promise<UserStoryRecord> {
    const current = await this.require(userId, hauntId);
    const { publishedKey: _removed, publicStory: _public, ...rest } = current;
    const next: UserStoryRecord = { ...rest, status: "draft", version: current.version + 1, updatedAt: this.now() };
    await this.writeIf(next, expectedVersion);
    return next;
  }

  /** Deletes a draft. A published story must be unpublished first, so nothing listed disappears under someone's feet. */
  async remove(userId: string, hauntId: string): Promise<void> {
    const current = await this.require(userId, hauntId);
    if (current.status !== "draft") throw new UserStoryError("not_draft", "Unpublish this story before you delete it.");
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { userId, hauntId },
          ConditionExpression: "#s = :draft",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":draft": "draft" },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw new UserStoryError("not_draft", "Unpublish this story before you delete it.");
      throw error;
    }
  }

  /** Community: the newest published stories, by publish date. One page; `truncated` says when there are more. */
  async listPublished(limit: number): Promise<{ stories: CommunityCard[]; truncated: boolean }> {
    const out = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "published-by-date",
        KeyConditionExpression: "publishedKey = :p",
        ExpressionAttributeValues: { ":p": "published" },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return {
      stories: ((out.Items ?? []) as UserStoryRecord[]).map(communityCard),
      truncated: out.LastEvaluatedKey !== undefined,
    };
  }

  /**
   * One published story for Community playback. The table is keyed by owner, so this reads the published index and filters
   * by hauntId. Walks every published page, so it is complete, but it grows with the number of published stories.
   */
  async findPublished(hauntId: string): Promise<UserStoryRecord | undefined> {
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < TABLE_LIMIT_PAGES; page++) {
      const out = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: "published-by-date",
          KeyConditionExpression: "publishedKey = :p",
          FilterExpression: "hauntId = :h",
          ExpressionAttributeValues: { ":p": "published", ":h": hauntId },
          ExclusiveStartKey: startKey,
        }),
      );
      const hit = ((out.Items ?? []) as UserStoryRecord[])[0];
      if (hit) return hit;
      startKey = out.LastEvaluatedKey;
      if (!startKey) return undefined;
    }
    throw new UserStoryQueryLimitError(this.table);
  }

  private async require(userId: string, hauntId: string): Promise<UserStoryRecord> {
    const record = await this.get(userId, hauntId);
    if (!record) throw new UserStoryError("not_found", "No such story.");
    return record;
  }

  /** Writes `next` only if the stored version is still `expectedVersion`. */
  private async writeIf(next: UserStoryRecord, expectedVersion: number): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: next,
          ConditionExpression: "#v = :e",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":e": expectedVersion },
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        throw new UserStoryError("conflict", "This story changed in another window. Reload to see the latest version.");
      }
      throw error;
    }
  }
}
