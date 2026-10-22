// GET /api/trending: the trending stories, from the trend-by-day index. Public, read-only, bounded.
// Off by default (HAUNT_TRENDING=on turns it on), because the index it reads does not exist until it is created.
import { Router, type Request, type Response } from "express";
import { trendingStories, type PlaySource } from "./trending.ts";

export const DEFAULT_TRENDING_LIMIT = 10;
export const MAX_TRENDING_LIMIT = 20;

/** Parses the limit: a whole number from 1 to MAX_TRENDING_LIMIT, or the default. Anything else is refused. */
export function trendingLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_TRENDING_LIMIT;
  if (typeof raw !== "string" || !/^\d{1,2}$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= 1 && value <= MAX_TRENDING_LIMIT ? value : undefined;
}

export function createTrendingRouter(options: {
  enabled: boolean;
  source: PlaySource | undefined;
  /** True when the story is published and eligible for playback. Ineligible stories are dropped, never shown. */
  isEligible: (storyId: string) => Promise<boolean>;
  now?: () => number;
}): Router {
  const router = Router();
  router.get("/", async (req: Request, res: Response) => {
    if (!options.enabled || !options.source) return void res.status(503).json({ error: "Trending isn't turned on yet." });
    const limit = trendingLimit(req.query.limit);
    if (limit === undefined) return void res.status(400).json({ error: `limit must be a whole number from 1 to ${MAX_TRENDING_LIMIT}.` });
    try {
      const now = options.now?.() ?? Date.now();
      // Ask for more than the limit, so that dropping ineligible stories still leaves enough to show.
      const { stories, truncated } = await trendingStories(options.source, { now, limit: MAX_TRENDING_LIMIT });
      const eligible: { storyId: string; score: number; plays: number }[] = [];
      for (const story of stories) {
        if (eligible.length >= limit) break;
        if (await options.isEligible(story.storyId)) eligible.push({ storyId: story.storyId, score: Math.round(story.score * 100) / 100, plays: story.plays });
      }
      res.json({ stories: eligible, truncated, window: "7d" });
    } catch (error) {
      // The reason stays in the server log. The Listener sees a plain message, never a table name or an error code.
      console.error("[trending] read failed:", (error as Error).name);
      res.status(503).json({ error: "Trending couldn't be loaded right now. Try again." });
    }
  });
  return router;
}
