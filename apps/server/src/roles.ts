import type { NextFunction, Request, Response } from "express";
import { userOf } from "./auth.ts";
import type { ProfileStore } from "./profiles.ts";

/**
 * Roles for Haunt listeners. The role is read from the server's profile record (`haunt-users`) on
 * every protected request. It is never taken from the request, the frontend, or Cognito user
 * attributes, and a missing role on an existing profile means LISTENER.
 *
 *   LISTENER  default: browse and listen, own profile, request Creator access
 *   CREATOR   LISTENER plus own-story creation and submission
 *   ADMIN     moderation, approvals, and role management (see creator-access.ts)
 */
export const ROLES = ["LISTENER", "CREATOR", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const DEFAULT_ROLE: Role = "LISTENER";

/** A stored role, or LISTENER when the profile has none or an unknown value. */
export function roleOf(stored: unknown): Role {
  return ROLES.includes(stored as Role) ? (stored as Role) : DEFAULT_ROLE;
}

/**
 * Puts the caller's current role in `res.locals.role`, then checks it against `allowed`.
 * 401 when there is no valid signed-in user. 403 when the role isn't allowed. The 403 message never
 * reveals what the protected resource is.
 */
export function requireRole(store: ProfileStore | undefined, allowed: readonly Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = userOf(res);
    if (!user) return void res.status(401).json({ error: "Sign in to continue." });
    if (!store) return void res.status(503).json({ error: "Accounts aren't available on this server yet." });
    try {
      const profile = await store.get(user.sub);
      const role = roleOf(profile?.role);
      if (!allowed.includes(role)) return void res.status(403).json({ error: "Your account can't do that." });
      res.locals.role = role;
      next();
    } catch (error) {
      console.error("[roles] role check failed:", (error as Error).name);
      res.status(503).json({ error: "Your account couldn't be checked right now. Try again." });
    }
  };
}

export const CREATOR_ROLES: readonly Role[] = ["CREATOR", "ADMIN"];
export const ADMIN_ROLES: readonly Role[] = ["ADMIN"];
