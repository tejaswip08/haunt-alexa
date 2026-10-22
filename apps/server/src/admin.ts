import { StoryNotFoundError, StoryStateError, type Story } from "@firetales/core";
import { StoryConflictError } from "@firetales/core/dynamodb";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { userOf } from "./auth.ts";
import { config } from "./config.ts";
import { contentHash, findSimilar, uniqueEntries, type LibraryEntry } from "./library.ts";
import { engine, library } from "./stories.ts";
import type { ProfileStore } from "./profiles.ts";
import { roleOf } from "./roles.ts";

/**
 * Publishing is admin-only: listeners can never publish, and no MCP tool can either.
 * Every route needs a signed-in account that is an ADMIN (the profile role, or the legacy Cognito admin group while that
 * switch is on). There is no shared-token path: a bearer secret never authorizes an admin action.
 *
 * Listeners' stories reach the library only through review: they submit, an admin approves
 * (which publishes) or rejects. Stories from before sign-in have no owner and are published
 * directly, as before.
 */
export const adminRouter = Router();

/** Queue of decisions per story, so two admins' publish/approve/reject/unpublish calls for one story run one after another. */
const storyQueues = new Map<string, Promise<unknown>>();
function serialized<T>(storyId: string, work: () => Promise<T>): Promise<T> {
  const run = (storyQueues.get(storyId) ?? Promise.resolve()).catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  storyQueues.set(storyId, tail);
  void tail.then(() => {
    if (storyQueues.get(storyId) === tail) storyQueues.delete(storyId);
  });
  return run;
}

/**
 * Takes back a library entry that this request created, after its decision couldn't be saved. It removes the
 * entry only while it still holds exactly what this request wrote, and the story isn't approved meanwhile.
 * Without these checks a concurrent approval's entry could be deleted.
 */
async function unpublishOwnWrite(storyId: string, written: LibraryEntry) {
  const [current, latest] = await Promise.all([library.get(storyId), engine.get(storyId)]);
  if (!current || current.publishedAt !== written.publishedAt || current.contentHash !== written.contentHash) return;
  if (latest.review?.status === "approved") return;
  await library.remove(storyId);
}

/** The profile store that holds each account's role (roles.ts). Set once by index.ts at startup. */
let adminProfiles: ProfileStore | undefined;
export function setAdminProfiles(store: ProfileStore | undefined) {
  adminProfiles = store;
}

/**
 * Admin authorization for every route on this router, decided on the server:
 *  - a signed-in account must have the ADMIN role on its profile (the authority), or, while the migration
 *    switch is on, be in the Cognito admin group. The group is set by Haunt's operators in Cognito, never by the client.
 *  - no signed-in account: refused. There is no shared admin token.
 */
async function requireAdmin(_req: Request, res: Response, next: NextFunction) {
  const user = userOf(res);
  // Anonymous callers, and any bearer secret that doesn't verify as a signed-in account, are refused here.
  if (!user) {
    res.status(403).json({ error: "Sign in as a Haunt admin to review or publish stories." });
    return;
  }
  if (config.legacyAdminGroup && user.admin) return next();
  if (!adminProfiles) {
    res.status(403).json({ error: "Only Haunt admins can review stories." });
    return;
  }
  try {
    const profile = await adminProfiles.get(user.sub);
    if (roleOf(profile?.role) === "ADMIN") return next();
  } catch (error) {
    console.error("[admin] role check failed:", (error as Error).name);
    res.status(503).json({ error: "Your account couldn't be checked right now. Try again." });
    return;
  }
  res.status(403).json({ error: "Only Haunt admins can review stories." });
}

adminRouter.use(requireAdmin);

adminRouter.get("/stories", async (_req, res) => {
  const [stories, published] = await Promise.all([engine.store.list(), library.list()]);
  const entries = uniqueEntries(published);
  const byId = new Map(entries.map((entry) => [entry.episode.storyId, entry]));
  // A listener's story stays private until they submit it; older ownerless stories are all listed, as before.
  const completed = stories.filter((story) => story.status === "completed" && (!story.ownerId || story.review));
  res.json({
    stories: await Promise.all(
      completed
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(async (story) => {
          const entry = byId.get(story.id);
          return {
            storyId: story.id,
            title: story.title,
            premise: story.config.premise,
            scenes: story.scenes.length,
            finishedAt: story.updatedAt,
            published: Boolean(entry),
            /** Listener stories go through review; ownerless ones (from before sign-in) don't. */
            fromListener: Boolean(story.ownerId),
            review: story.review ?? null,
            // So re-publishing starts from what's live instead of blank fields.
            creator: entry?.creator ?? story.review?.creator,
            summary: entry?.summary ?? story.review?.summary,
            opening: story.scenes[0]?.narration ?? "",
            similar: findSimilar(await engine.episode(story.id), entries),
          };
        }),
    ),
  });
});

const PublishSchema = z.object({
  storyId: z.string().min(1).max(64),
  creator: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(280),
  /** Publish even though another entry has identical narration. */
  allowDuplicate: z.boolean().optional(),
});

/**
 * Idempotent: the library is keyed by the source story id, so publishing the same story
 * again updates its entry (new summary, pen name or narration) and keeps its first
 * publish date. A *different* story with identical narration is refused unless confirmed.
 */
type PublishInput = z.infer<typeof PublishSchema>;

/** Writes the library entry. Answers 409 itself and returns undefined when the content is a duplicate. */
async function publishEntry(res: Response, { storyId, creator, summary, allowDuplicate }: PublishInput) {
  const episode = await engine.episode(storyId);
  const [existing, all] = await Promise.all([library.get(storyId), library.list()]);
  const similar = findSimilar(episode, uniqueEntries(all));
  const sameContent = similar.find((entry) => entry.reason === "same content");
  if (sameContent && !allowDuplicate) {
    res.status(409).json({
      error: `"${sameContent.title}" (${sameContent.storyId}) already has exactly the same narration. Unpublish it first, or confirm to publish both.`,
      duplicateOf: sameContent.storyId,
    });
    return undefined;
  }
  const now = new Date().toISOString();
  const written: LibraryEntry = {
    episode,
    creator,
    summary,
    publishedAt: existing?.publishedAt ?? now,
    ...(existing ? { updatedAt: now } : {}),
    contentHash: contentHash(episode),
  };
  // A create is conditional, so two servers publishing the same story at once can't overwrite each other's entry.
  if (existing) {
    await library.put(written);
    return { action: "updated" as const, warnings: similar, written };
  }
  if (!(await library.putIfAbsent(written))) {
    res.status(409).json({ error: "Someone else just published this story. Refresh and try again." });
    return undefined;
  }
  return { action: "created" as const, warnings: similar, written };
}

/**
 * A story's owner may not review or publish it, admins included: a decision needs a second person.
 * Returns true, after answering 403, when the signed-in caller owns the story.
 */
function refuseOwnStory(story: Story, res: Response): boolean {
  const actor = userOf(res)?.sub;
  if (!actor || !story.ownerId || story.ownerId !== actor) return false;
  res.status(403).json({ error: "You can't review or publish your own story." });
  return true;
}

function storyErrors(res: Response, error: unknown) {
  if (error instanceof StoryNotFoundError || error instanceof StoryStateError) {
    // StoryConflictError is a StoryStateError: someone else changed it; the admin can retry.
    res.status(error instanceof StoryConflictError ? 409 : 400).json({ error: error.message });
    return;
  }
  throw error;
}

/**
 * Idempotent: the library is keyed by the source story id, so publishing the same story
 * again updates its entry (new summary, pen name or narration) and keeps its first
 * publish date. A *different* story with identical narration is refused unless confirmed.
 * A listener's story must be approved first; after that, this edits its entry.
 */
adminRouter.post("/publish", async (req, res) => {
  const parsed = PublishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  await serialized(parsed.data.storyId, async () => {
    try {
      const story = await engine.get(parsed.data.storyId);
      if (refuseOwnStory(story, res)) return;
      if (story.ownerId && story.review?.status !== "approved") {
        res.status(409).json({ error: "This is a listener's story: it goes in the library by approving their submission." });
        return;
      }
      const published = await publishEntry(res, parsed.data);
      if (published) res.json({ ok: true, action: published.action, warnings: published.warnings });
    } catch (error) {
      storyErrors(res, error);
    }
  });
});

const ApproveSchema = PublishSchema.extend({
  creator: z.string().trim().min(1).max(40).optional(),
  summary: z.string().trim().min(1).max(280).optional(),
});

/** Publishes a submitted story, with the listener's pen name and summary unless the admin edits them. */
adminRouter.post("/approve", async (req, res) => {
  const parsed = ApproveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  await serialized(parsed.data.storyId, async () => {
    try {
      const story = await engine.get(parsed.data.storyId);
      if (refuseOwnStory(story, res)) return;
      const review = submittedReview(res, story);
      if (!review) return;
      const creator = parsed.data.creator ?? review.creator;
      const summary = parsed.data.summary ?? review.summary;
      // Library first: if saving the decision then fails, approving again finishes the job.
      const published = await publishEntry(res, { ...parsed.data, creator, summary });
      if (!published) return;
      story.review = { ...review, creator, summary, status: "approved", decidedAt: new Date().toISOString() };
      delete story.review.reason;
      try {
        await engine.store.put(story);
      } catch (error) {
        // The decision wasn't saved (a conflict, or any other store failure). Take back the entry this request created,
        // so a story that isn't approved isn't left public. If the save did land despite the error, the story reads as
        // approved and unpublishOwnWrite leaves the entry alone.
        if (published.action === "created") await unpublishOwnWrite(story.id, published.written);
        throw error;
      }
      res.json({ ok: true, action: published.action, warnings: published.warnings });
    } catch (error) {
      storyErrors(res, error);
    }
  });
});

adminRouter.post("/reject", async (req, res) => {
  const parsed = z
    .object({ storyId: z.string().min(1).max(64), reason: z.string().trim().min(1).max(280) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  await serialized(parsed.data.storyId, async () => {
    try {
      const story = await engine.get(parsed.data.storyId);
      if (refuseOwnStory(story, res)) return;
      const review = submittedReview(res, story);
      if (!review) return;
      story.review = { ...review, status: "rejected", reason: parsed.data.reason, decidedAt: new Date().toISOString() };
      await engine.store.put(story);
      res.json({ ok: true });
    } catch (error) {
      storyErrors(res, error);
    }
  });
});

/** The pending submission, or a 409 explaining why there's nothing to decide. */
function submittedReview(res: Response, story: Story) {
  if (story.review?.status === "submitted") return story.review;
  res.status(409).json({
    error: !story.review
      ? "Nobody has submitted this story."
      : `This story was already ${story.review.status}.`,
  });
  return undefined;
}

adminRouter.post("/unpublish", async (req, res) => {
  const parsed = z.object({ storyId: z.string().min(1).max(64) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: z.prettifyError(parsed.error) });
    return;
  }
  await serialized(parsed.data.storyId, async () => {
    await library.remove(parsed.data.storyId);
    res.json({ ok: true });
  });
});
