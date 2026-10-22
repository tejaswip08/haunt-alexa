import { Router, type Request, type Response } from "express";
import { userOf } from "./auth.ts";
import { ProfilePatchSchema, type ProfileStore } from "./profiles.ts";
import { z } from "zod";

/**
 * The signed-in listener's own profile.
 *
 *   GET   /api/users/me   the profile (created on first use, for accounts that predate profiles too)
 *   PATCH /api/users/me   the fields a listener may change (see ProfilePatchSchema)
 *
 * The user is taken from the verified session (res.locals.user), never from the request. A listener
 * can't read or change another listener's profile, because there is no way to name one.
 */
export function createUsersRouter(store: ProfileStore | undefined): Router {
  const router = Router();

  const unavailable = (res: Response) => res.status(503).json({ error: "Profiles aren't available on this server yet." });
  const requireUser = (req: Request, res: Response): string | undefined => {
    const user = userOf(res);
    if (!user) {
      res.status(401).json({ error: "Sign in to see your profile." });
      return undefined;
    }
    return user.sub;
  };

  router.get("/me", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    if (!store) return void unavailable(res);
    try {
      // Email isn't known here; it was recorded at sign-in if Cognito reported it verified.
      res.json({ profile: await store.ensure(userId, null) });
    } catch (error) {
      console.error("[users] profile read failed:", (error as Error).name);
      res.status(503).json({ error: "Your profile couldn't be loaded. Try again." });
    }
  });

  router.patch("/me", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    if (!store) return void unavailable(res);
    const parsed = ProfilePatchSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    try {
      // Make sure the profile exists first, so a PATCH after a failed creation still works without duplicates.
      await store.ensure(userId, null);
      const updated = await store.update(userId, parsed.data);
      if (!updated) return void res.status(404).json({ error: "Your profile couldn't be found. Try again." });
      res.json({ profile: updated });
    } catch (error) {
      console.error("[users] profile update failed:", (error as Error).name);
      res.status(503).json({ error: "Your profile couldn't be saved. Try again." });
    }
  });

  return router;
}
