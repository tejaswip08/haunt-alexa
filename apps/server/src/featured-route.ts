// Featured Tonight routes. The public read shows only active, eligible features. Writes are admin-only: the caller mounts
// `adminOnly` (the existing requireRole middleware, ADMIN role) in front of createFeaturedAdminRouter.
import { Router, type Request, type RequestHandler, type Response } from "express";
import { activeFeatured, FeatureVersionError, removeFeature, upsertFeature, validateFeature, type FeaturedStore } from "./featured.ts";

export function createFeaturedPublicRouter(options: { enabled: boolean; store: FeaturedStore | undefined; isPublished: (storyId: string) => Promise<boolean>; now?: () => number }): Router {
  const router = Router();
  router.get("/", async (_req: Request, res: Response) => {
    if (!options.enabled || !options.store) return void res.status(503).json({ error: "Featured Tonight isn't turned on yet." });
    try {
      const now = options.now?.() ?? Date.now();
      const { entries } = await options.store.read();
      const features: { storyId: string; startsAt: string; endsAt: string }[] = [];
      for (const entry of activeFeatured(entries, now)) {
        // A feature whose story is no longer published is not shown, even while its window is open.
        if (await options.isPublished(entry.storyId)) features.push(entry);
      }
      // An empty list is the fallback: the app shows its normal Home content.
      res.json({ features, fallback: features.length === 0 });
    } catch (error) {
      console.error("[featured] read failed:", (error as Error).name);
      res.status(503).json({ error: "Featured Tonight couldn't be loaded right now." });
    }
  });
  return router;
}

export function createFeaturedAdminRouter(options: {
  enabled: boolean;
  store: FeaturedStore | undefined;
  isPublished: (storyId: string) => Promise<boolean>;
  adminOnly: RequestHandler;
  now?: () => number;
}): Router {
  const router = Router();
  router.use(options.adminOnly);
  const off = (res: Response) => res.status(503).json({ error: "Featured Tonight isn't turned on yet." });
  const version = (raw: unknown): number | undefined => {
    const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };

  router.get("/", async (_req: Request, res: Response) => {
    if (!options.enabled || !options.store) return void off(res);
    try {
      res.json(await options.store.read());
    } catch (error) {
      console.error("[featured] admin read failed:", (error as Error).name);
      res.status(503).json({ error: "The schedule couldn't be loaded right now." });
    }
  });

  router.put("/", async (req: Request, res: Response) => {
    if (!options.enabled || !options.store) return void off(res);
    const expected = version(req.body?.expectedVersion);
    if (expected === undefined) return void res.status(400).json({ error: "Send the schedule version you are changing (expectedVersion)." });
    const checked = validateFeature(req.body ?? {}, options.now?.() ?? Date.now());
    if (!checked.ok) return void res.status(400).json({ error: checked.problems.join(" "), problems: checked.problems });
    if (!(await options.isPublished(checked.entry.storyId))) {
      return void res.status(422).json({ error: "Only a published story can be featured." });
    }
    try {
      const now = options.now?.() ?? Date.now();
      const current = await options.store.read();
      const entries = upsertFeature(current.entries, checked.entry, now);
      const next = await options.store.write(entries, expected, now);
      res.json({ version: next, entries });
    } catch (error) {
      if (error instanceof FeatureVersionError) return void res.status(409).json({ error: error.message });
      console.error("[featured] save failed:", (error as Error).name);
      res.status(503).json({ error: "The schedule couldn't be saved right now. Try again." });
    }
  });

  router.delete("/:storyId", async (req: Request, res: Response) => {
    if (!options.enabled || !options.store) return void off(res);
    const expected = version(req.query.expectedVersion);
    if (expected === undefined) return void res.status(400).json({ error: "Send the schedule version you are changing (expectedVersion)." });
    try {
      const now = options.now?.() ?? Date.now();
      const current = await options.store.read();
      const next = await options.store.write(removeFeature(current.entries, String(req.params.storyId)), expected, now);
      res.json({ version: next, entries: removeFeature(current.entries, String(req.params.storyId)) });
    } catch (error) {
      if (error instanceof FeatureVersionError) return void res.status(409).json({ error: error.message });
      console.error("[featured] remove failed:", (error as Error).name);
      res.status(503).json({ error: "The schedule couldn't be saved right now. Try again." });
    }
  });
  return router;
}
