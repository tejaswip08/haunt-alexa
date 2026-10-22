import type { SplitStore } from "./split-records.ts";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { userOf } from "./auth.ts";
import type { EngagementStore } from "./engagement.ts";
import type { Library } from "./library.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { UserStoryStore } from "./user-stories.ts";

/**
 * Likes and play counts for published stories (Community and Haunt Originals alike).
 *
 *   GET    /api/library/stats?ids=a,b          totals for up to 50 published stories (public)
 *   GET    /api/library/:storyId/stats         totals, plus whether the signed-in caller likes it (public)
 *   PUT    /api/library/:storyId/like          like it (signed in). Idempotent.
 *   DELETE /api/library/:storyId/like          remove your like (signed in). Idempotent.
 *   POST   /api/library/:storyId/plays         record a playback start: body { playId } (public). Idempotent per playId.
 *
 * The user comes from the verified session, never from the request, so nobody can like on someone else's behalf. Guests can
 * play (their starts count) but can't like, since guests have no stable identity to hold a like.
 * A story must be published in the library: anything else answers 404, like a missing story.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PLAY_ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_IDS = 50;
/** A published user story (My Stories). Its id always starts "us_", so it can never be mistaken for a library story. */
const USER_STORY_ID = /^us_[A-Za-z0-9_-]{16}$/;

export function createEngagementRouter(
  engagement: EngagementStore | undefined,
  library: Library,
  limiter: RateLimiter,
  split?: SplitStore,
  userStories?: UserStoryStore,
): Router {
  const router = Router();

  const unavailable = (res: Response) =>
    res.status(503).json({ error: "Likes and play counts need the database on this server." });

  /** The story's id when it is a published story, otherwise undefined (the route then answers 404). */
  async function publishedId(raw: unknown): Promise<string | undefined> {
    const storyId = String(raw ?? "");
    if (!SAFE_ID.test(storyId)) return undefined;
    if (await library.get(storyId)) return storyId;
    // A user story counts only while it is published. Drafts and unpublished stories answer 404 here.
    if (userStories && USER_STORY_ID.test(storyId) && (await userStories.findPublished(storyId))) return storyId;
    return undefined;
  }

  const notFound = (res: Response) => res.status(404).json({ error: "No such story." });

  /** Per-IP limit for the write routes. Returns false, after answering 429, when the caller is over it. */
  function allow(req: Request, res: Response): boolean {
    const verdict = limiter.hit(`library:${req.ip}`);
    if (verdict.ok) return true;
    res.set("Retry-After", String(verdict.retryAfterSeconds)).status(429).json({ error: "Too many requests. Wait a moment and try again." });
    return false;
  }

  router.get("/stats", async (req, res) => {
    if (!engagement) return void unavailable(res);
    const ids = String(req.query.ids ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_IDS);
    try {
      const stats: Record<string, { likes: number; plays: number }> = {};
      await Promise.all(
        ids.map(async (raw) => {
          const storyId = await publishedId(raw);
          if (storyId) stats[storyId] = await engagement.counts(storyId);
        }),
      );
      res.json({ stats });
    } catch (error) {
      console.error("[library] stats failed:", (error as Error).name);
      unavailable(res);
    }
  });

  router.get("/:storyId/stats", async (req, res) => {
    if (!engagement) return void unavailable(res);
    const storyId = await publishedId(req.params.storyId);
    if (!storyId) return void notFound(res);
    const user = userOf(res);
    try {
      const legacyLiked = (sub: string) => engagement.liked(storyId, sub);
      const [counts, liked] = await Promise.all([
        engagement.counts(storyId),
        user ? (split ? split.liked(user.sub, storyId, () => legacyLiked(user.sub)) : legacyLiked(user.sub)) : false,
      ]);
      res.json({ ...counts, liked });
    } catch (error) {
      console.error("[library] counts failed:", (error as Error).name);
      unavailable(res);
    }
  });

  for (const liked of [true, false]) {
    const handler = async (req: Request, res: Response) => {
      if (!engagement) return void unavailable(res);
      const user = userOf(res);
      if (!user) return void res.status(401).json({ error: "Sign in to like a story." });
      if (!allow(req, res)) return;
      const storyId = await publishedId(req.params.storyId);
      if (!storyId) return void notFound(res);
      // Likes are written only to haunt-likes (one item per user and story); the total stays in the story's counter.
      if (!split) return void unavailable(res);
      try {
        const { liked: state } = await split.setLike(user.sub, storyId, liked);
        const counts = await engagement.counts(storyId);
        return void res.json({ ok: true, liked: state, likes: counts.likes, plays: counts.plays });
      } catch (error) {
        console.error("[library] like failed:", (error as Error).name);
        unavailable(res);
      }
    };
    if (liked) router.put("/:storyId/like", handler);
    else router.delete("/:storyId/like", handler);
  }

  const PlaySchema = z.object({ playId: z.string().regex(PLAY_ID) });
  router.post("/:storyId/plays", async (req, res) => {
    if (!engagement) return void unavailable(res);
    const parsed = PlaySchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Each playback needs a playId of 8 to 64 letters, digits, or dashes." });
    if (!allow(req, res)) return;
    const storyId = await publishedId(req.params.storyId);
    if (!storyId) return void notFound(res);
    try {
      res.json({ ok: true, ...(await engagement.recordPlay(storyId, parsed.data.playId)) });
    } catch (error) {
      console.error("[library] play failed:", (error as Error).name);
      unavailable(res);
    }
  });

  return router;
}
