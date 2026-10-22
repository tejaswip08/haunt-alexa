import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { userOf, type User } from "./auth.ts";
import { ApprovalError, reviewSummary, SUBMISSION_STATUSES, type StoryApprovalStore, type SubmissionStatus } from "./story-approvals.ts";
import type { ProfileStore } from "./profiles.ts";
import { roleOf } from "./roles.ts";
import type { UserStoryStore } from "./user-stories.ts";

/**
 * Review of My Stories submissions. Admin only, checked on the server for every request:
 *
 *   GET  /api/admin/story-submissions?status=PENDING_APPROVAL   the queue (default: pending)
 *   GET  /api/admin/story-submissions/:submissionId            one submission and the revision it reviewed
 *   POST /api/admin/story-submissions/:submissionId/approve    publishes that exact revision
 *   POST /api/admin/story-submissions/:submissionId/reject     body: { reason }; the story stays a private draft
 *
 * The reviewer must be a signed-in user with the ADMIN role (or the legacy admin group while that migration is on, as in
 * admin.ts). A client-sent flag is never trusted, and the shared admin token is refused, because a review needs a named reviewer.
 * A reviewer never reviews their own story.
 */

const SUBMISSION_ID = /^us_[A-Za-z0-9_-]{16}#\d+$/;

/**
 * The one admin rule for story review and cover reads: the ADMIN profile role, or the legacy Cognito admin group while that
 * migration is on. The shared admin token never counts here, because it names no user.
 */
export async function isNamedAdmin(user: User, profiles: ProfileStore | undefined, legacyAdmin: boolean): Promise<boolean> {
  if (legacyAdmin && user.admin) return true;
  const profile = profiles ? await profiles.get(user.sub) : undefined;
  return roleOf(profile?.role) === "ADMIN";
}
const RejectSchema = z.object({ reason: z.string().max(500) });

export interface ReviewDeps {
  approvals: StoryApprovalStore;
  stories: UserStoryStore;
  profiles: ProfileStore | undefined;
  /** The Cognito admin group, honoured only while the migration switch is on (config.legacyAdminGroup). */
  legacyAdmin: boolean;
}

const STATUSES = new Set<string>(SUBMISSION_STATUSES);

function fail(res: Response, error: unknown) {
  if (error instanceof ApprovalError) {
    const status = { not_found: 404, forbidden: 403, invalid: 422, conflict: 409, stale: 409 }[error.code];
    return void res.status(status).json({ error: error.message, problems: error.problems });
  }
  console.error("[story-review] failed:", (error as Error).name);
  res.status(503).json({ error: "Reviews aren't available right now. Try again in a moment." });
}

export function createStoryReviewRouter(deps: ReviewDeps): Router {
  const router = Router();

  /** Verified admin only. Runs before every route below. */
  async function requireReviewer(req: Request, res: Response, next: NextFunction) {
    const user = userOf(res);
    if (!user) return void res.status(403).json({ error: "Sign in as a Haunt admin to review stories." });
    try {
      if (await isNamedAdmin(user, deps.profiles, deps.legacyAdmin)) return next();
    } catch (error) {
      console.error("[story-review] role check failed:", (error as Error).name);
      return void res.status(503).json({ error: "Your account couldn't be checked right now. Try again." });
    }
    res.status(403).json({ error: "Only Haunt admins can review stories." });
  }

  router.use(requireReviewer);

  router.get("/", async (req, res) => {
    const requested = typeof req.query.status === "string" ? req.query.status : "PENDING_APPROVAL";
    if (!STATUSES.has(requested)) return void res.status(422).json({ error: "Unknown status." });
    try {
      const submissions = await deps.approvals.listByStatus(requested as SubmissionStatus);
      const summaries = await Promise.all(
        submissions.map(async (submission) => reviewSummary(submission, await deps.stories.get(submission.submittedBy, submission.storyId))),
      );
      res.json({ submissions: summaries });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/:submissionId", async (req, res) => {
    const submissionId = String(req.params.submissionId);
    if (!SUBMISSION_ID.test(submissionId)) return void res.status(404).json({ error: "No such submission." });
    try {
      const submission = await deps.approvals.get(submissionId);
      if (!submission) return void res.status(404).json({ error: "No such submission." });
      const story = await deps.stories.get(submission.submittedBy, submission.storyId);
      // The reviewer reads the story as the creator stored it. Approval checks the revision again, so this view is not trusted for it.
      res.json({ submission: reviewSummary(submission, story), story: story?.story ?? null, storyVersion: story?.version ?? null });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:submissionId/approve", async (req, res) => {
    const submissionId = String(req.params.submissionId);
    if (!SUBMISSION_ID.test(submissionId)) return void res.status(404).json({ error: "No such submission." });
    try {
      const submission = await deps.approvals.approve(userOf(res)!.sub, submissionId);
      res.json({ submission });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/:submissionId/reject", async (req, res) => {
    const submissionId = String(req.params.submissionId);
    if (!SUBMISSION_ID.test(submissionId)) return void res.status(404).json({ error: "No such submission." });
    const parsed = RejectSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(422).json({ error: "Give a reason of 500 characters or fewer." });
    try {
      const submission = await deps.approvals.reject(userOf(res)!.sub, submissionId, parsed.data.reason);
      res.json({ submission });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
