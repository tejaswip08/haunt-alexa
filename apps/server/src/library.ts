import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Episode } from "@firetales/core";

export interface LibraryEntry {
  episode: Episode;
  /** Pseudonym chosen at publish time. Never the listener's real name. */
  creator: string;
  summary: string;
  /** When the story was first published. Kept when it's published again. */
  publishedAt: string;
  /** When it was last re-published (new summary, pen name or narration). */
  updatedAt?: string;
  /** SHA-256 of the episode's narration, to spot the same story published under another id. */
  contentHash?: string;
  /** "HAUNT_ORIGINAL" for stories written by the Haunt team. Missing on community submissions. */
  source?: "HAUNT_ORIGINAL";
  genre?: string;
  subgenre?: string;
  /** A spoiler-free description of how the story ends. */
  ending?: string;
}
// Likes and play totals are not stored here: publishing rewrites this entry, which would reset them. See engagement.ts.

/** Fingerprint of an episode's narration, ignoring whitespace and case. */
export function contentHash(episode: Pick<Episode, "script">): string {
  const normalized = episode.script.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export interface SimilarEntry {
  storyId: string;
  title: string;
  /** "same content" means the narration is identical: almost certainly a duplicate. */
  reason: "same content" | "same title" | "same premise";
}

/**
 * Other library entries that look like `episode`. Entries are keyed by source story id,
 * so the same story can never appear twice; this catches *different* stories that
 * would look alike in the library.
 */
export function findSimilar(episode: Episode, entries: LibraryEntry[]): SimilarEntry[] {
  const hash = contentHash(episode);
  const title = normalize(episode.title);
  const premise = normalize(episode.premise);
  const similar: SimilarEntry[] = [];
  for (const entry of entries) {
    if (entry.episode.storyId === episode.storyId) continue;
    const reason =
      (entry.contentHash ?? contentHash(entry.episode)) === hash
        ? "same content"
        : normalize(entry.episode.title) === title
          ? "same title"
          : normalize(entry.episode.premise) === premise
            ? "same premise"
            : undefined;
    if (reason) similar.push({ storyId: entry.episode.storyId, title: entry.episode.title, reason });
  }
  return similar;
}

/** One entry per source story id, newest first, even if a store ever returned duplicates. */
export function uniqueEntries(entries: LibraryEntry[]): LibraryEntry[] {
  const byId = new Map<string, LibraryEntry>();
  for (const entry of entries) {
    const seen = byId.get(entry.episode.storyId);
    if (!seen || (entry.updatedAt ?? entry.publishedAt) > (seen.updatedAt ?? seen.publishedAt)) byId.set(entry.episode.storyId, entry);
  }
  return [...byId.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/** Finished episodes that anyone can listen to. Only the admin can add or remove them. */
export interface Library {
  list(): Promise<LibraryEntry[]>;
  get(storyId: string): Promise<LibraryEntry | undefined>;
  put(entry: LibraryEntry): Promise<void>;
  /** Writes an entry only if none exists for that story. Returns false when one already did. */
  putIfAbsent(entry: LibraryEntry): Promise<boolean>;
  remove(storyId: string): Promise<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const newestFirst = (a: LibraryEntry, b: LibraryEntry) => b.publishedAt.localeCompare(a.publishedAt);

export class FileLibrary implements Library {
  constructor(private readonly dir: string) {}

  #file(storyId: string) {
    if (!SAFE_ID.test(storyId)) throw new Error(`Invalid story id: ${storyId}`);
    return path.join(this.dir, `${storyId}.json`);
  }

  async list() {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => JSON.parse(await readFile(path.join(this.dir, name), "utf8")) as LibraryEntry),
    );
    return entries.sort(newestFirst);
  }

  async get(storyId: string) {
    if (!SAFE_ID.test(storyId)) return undefined;
    try {
      return JSON.parse(await readFile(this.#file(storyId), "utf8")) as LibraryEntry;
    } catch {
      return undefined;
    }
  }

  async put(entry: LibraryEntry) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.#file(entry.episode.storyId), JSON.stringify(entry, null, 2));
  }

  /** `wx` makes the write fail if the file already exists, the file-store equivalent of `attribute_not_exists`. */
  async putIfAbsent(entry: LibraryEntry): Promise<boolean> {
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(this.#file(entry.episode.storyId), JSON.stringify(entry, null, 2), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async remove(storyId: string) {
    await rm(this.#file(storyId), { force: true });
  }
}

export class DynamoLibrary implements Library {
  readonly #prefix = "library#";
  constructor(
    private readonly client: Pick<DynamoDBDocumentClient, "send">,
    private readonly table: string,
  ) {}

  async list() {
    const entries: LibraryEntry[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "begins_with(id, :prefix)",
          ExpressionAttributeValues: { ":prefix": this.#prefix },
          ExclusiveStartKey: start,
        }),
      );
      for (const item of page.Items ?? []) entries.push(item.entry as LibraryEntry);
      start = page.LastEvaluatedKey;
    } while (start);
    return entries.sort(newestFirst);
  }

  async get(storyId: string) {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.table, Key: { id: this.#prefix + storyId } }));
    return Item?.entry as LibraryEntry | undefined;
  }

  async put(entry: LibraryEntry) {
    await this.client.send(
      new PutCommand({ TableName: this.table, Item: { id: this.#prefix + entry.episode.storyId, entry } }),
    );
  }

  /** Writes an entry only if none exists for that story. Returns false when one already did. */
  async putIfAbsent(entry: LibraryEntry): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: { id: this.#prefix + entry.episode.storyId, entry },
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
      return true;
    } catch (error) {
      if ((error as Error).name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async remove(storyId: string) {
    await this.client.send(new DeleteCommand({ TableName: this.table, Key: { id: this.#prefix + storyId } }));
  }
}
