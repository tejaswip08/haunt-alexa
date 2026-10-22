import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { randomUUID } from "node:crypto";

/**
 * Story cover images. The bucket is private: the browser uploads with a short-lived presigned POST, and readers are sent to a
 * short-lived presigned GET by /api/covers/... . Nothing is public, and no AWS key ever reaches the browser.
 *
 *   key      covers/<owner sub>/<story id>/<random uuid>.<ext>
 *   coverUrl /api/covers/<owner sub>/<story id>/<random uuid>.<ext>   (what a story stores; same origin as the app)
 *
 * The random uuid makes every upload a new key, so an upload never overwrites another image. The owner and story come from the
 * verified session and the stored story, never from the browser's key.
 */

export const COVER_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type CoverType = keyof typeof COVER_TYPES;

export const MAX_COVER_BYTES = 5 * 1024 * 1024;
/** Lifetime of a presigned upload form. Reads are streamed by the server, so no read link is ever handed out. */
export const UPLOAD_TTL_SECONDS = 300;

const SUB = "[A-Za-z0-9-]{1,64}";
const HAUNT = "us_[A-Za-z0-9_-]{16}";
const FILE = "[0-9a-f-]{36}\\.(?:jpg|png|webp)";
/** The path a story stores as coverUrl, and the same path without the /api prefix (the S3 key). */
export const COVER_PATH_SOURCE = `/api/covers/covers/${SUB}/${HAUNT}/${FILE}`;
const COVER_KEY = new RegExp(`^covers/${SUB}/${HAUNT}/${FILE}$`);
const COVER_PATH = new RegExp(`^${COVER_PATH_SOURCE}$`);

export interface CoverUpload {
  url: string;
  fields: Record<string, string>;
}

/** The storage the covers need. The S3 version below is the only real one; tests use a fake. */
export interface CoverStorage {
  presignUpload(key: string, contentType: CoverType): Promise<CoverUpload>;
  exists(key: string): Promise<boolean>;
  /** The object's bytes, streamed by the server for an authorized request. Undefined when there is no such object. */
  read(key: string): Promise<Readable | undefined>;
}

export function coverKey(owner: string, hauntId: string, type: CoverType): string {
  return `covers/${owner}/${hauntId}/${randomUUID()}.${COVER_TYPES[type]}`;
}

/** The stored coverUrl for a key. */
export function coverPath(key: string): string {
  return `/api/covers/${key}`;
}

/** The key behind a stored coverUrl, or null when the path is not a cover path. */
export function keyFromCoverPath(path: string): string | null {
  if (!COVER_PATH.test(path)) return null;
  return path.slice("/api/covers/".length);
}

export function isValidCoverKey(key: string): boolean {
  return COVER_KEY.test(key);
}

/** The key must sit under the story's own folder. A cover from another owner or story is refused. */
export function keyBelongsTo(key: string, owner: string, hauntId: string): boolean {
  return key.startsWith(`covers/${owner}/${hauntId}/`);
}

/** A cover problem for a story save: the uploaded object must exist under this owner's story. Null when it is fine. */
export async function coverSaveProblem(
  storage: CoverStorage | undefined,
  owner: string,
  hauntId: string,
  coverUrl: string,
): Promise<string | null> {
  if (!coverUrl || !coverUrl.startsWith("/api/covers/")) return null;
  const key = keyFromCoverPath(coverUrl);
  if (!key || !keyBelongsTo(key, owner, hauntId)) return "That cover image isn't one of this story's uploads.";
  if (!storage) return "Cover uploads aren't set up on this server.";
  if (!(await storage.exists(key))) return "The cover image wasn't uploaded. Upload it again.";
  return null;
}

/** Real storage: a private S3 bucket named by HAUNT_COVER_BUCKET. */
export class S3CoverStorage implements CoverStorage {
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client,
  ) {}

  async presignUpload(key: string, contentType: CoverType): Promise<CoverUpload> {
    const { url, fields } = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ["content-length-range", 1, MAX_COVER_BYTES],
        ["eq", "$Content-Type", contentType],
      ],
      Fields: { "Content-Type": contentType },
      Expires: UPLOAD_TTL_SECONDS,
    });
    return { url, fields };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NotFound" || name === "NoSuchKey") return false;
      throw error;
    }
  }

  async read(key: string): Promise<Readable | undefined> {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.Body as Readable | undefined;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === "NoSuchKey" || name === "NotFound") return undefined;
      throw error;
    }
  }
}

/** Storage from the environment, or undefined when no bucket is configured (uploads then report unavailable). */
export function coverStorageFromEnv(env: NodeJS.ProcessEnv = process.env): CoverStorage | undefined {
  const bucket = env.HAUNT_COVER_BUCKET?.trim();
  if (!bucket) return undefined;
  return new S3CoverStorage(bucket, new S3Client({ region: env.AWS_REGION ?? "us-east-1" }));
}
