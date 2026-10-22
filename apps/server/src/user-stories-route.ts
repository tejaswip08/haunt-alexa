import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { identify, userOf, type Authenticator, type User } from "./auth.ts";
import type { Library } from "./library.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { communityCard, creatorOf, episodeFor, publicRevisionOf, StoryInputSchema, UserStoryError, UserStoryQueryLimitError, type UserStoryRecord, type UserStoryStore } from "./user-stories.ts";
import { coverKey, coverPath, coverSaveProblem, isValidCoverKey, MAX_COVER_BYTES, UPLOAD_TTL_SECONDS, type CoverStorage } from "./covers.ts";
import { ApprovalError, reviewSummary, submissionIdFor, type StoryApprovalStore } from "./story-approvals.ts";
import { CREATOR_ROLES, requireRole, roleOf } from "./roles.ts";
import { StorySettingsSchema, GenerationError, type SettingsGenerator } from "./story-regenerate.ts";
import type { ProfileStore } from "./profiles.ts";

/**
 * My Stories (signed in) and Community (public, published only).
 *
 *   GET    /api/me/user-stories                 the caller's own stories, newest first
 *   POST   /api/me/user-stories                 create a draft
 *   GET    /api/me/user-stories/:id             one of the caller's stories
 *   PUT    /api/me/user-stories/:id             edit (body: the story plus expectedVersion)
 *   POST   /api/me/user-stories/:id/preview     problems and the episode as it would play (no write)
 *   POST   /api/me/user-stories/:id/submit      send the current revision for admin review (story-approvals.ts)
 *   GET    /api/me/user-stories/:id/submissions this story's review history (the caller's own)
 *   GET    /api/me/user-stories/review-status   the caller's review history, all stories
 *   POST   /api/me/user-stories/:id/publish     refused (403): stories go public only through admin approval
 *   POST   /api/me/user-stories/:id/unpublish   take off Community (body: expectedVersion)
 *   DELETE /api/me/user-stories/:id             delete a draft only
 *
 *   GET    /api/community/stories          production stories and published community stories, newest first
 *   GET    /api/community/stories/:id      one story to play
 *
 * The owner is always the verified session's `sub`. The body never names an owner, and a story id that belongs to someone
 * else is answered exactly like a missing one.
 */

const HAUNT_ID = /^us_[A-Za-z0-9_-]{16}$/;
const VersionSchema = z.object({ expectedVersion: z.number().int().min(1).max(1_000_000_000) });
const LIST_LIMIT = 50;

function fail(res: Response, error: unknown) {
  if (error instanceof UserStoryError) {
    if (error.code === "not_found") return void res.status(404).json({ error: error.message });
    if (error.code === "invalid") return void res.status(422).json({ error: error.message, problems: error.problems });
    return void res.status(409).json({ error: error.message });
  }
  if (error instanceof UserStoryQueryLimitError) {
    console.error("[my-stories] read stopped:", error.table);
    return void res.status(503).json({ error: "Your stories can't be listed right now. Try again later." });
  }
  console.error("[my-stories] failed:", (error as Error).name);
  res.status(503).json({ error: "Stories aren't available right now. Try again in a moment." });
}

const CoverRequestSchema = z.object({
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  size: z.number().int().min(1).max(MAX_COVER_BYTES),
});

/** The content type of a cover, from its stored extension. Only these three image types are ever served. */
const COVER_CONTENT_TYPE: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

export interface CoverReadDeps {
  storage: CoverStorage | undefined;
  stories: UserStoryStore;
  approvals: StoryApprovalStore | undefined;
  /** True for a signed-in user who is a named admin. Called only with a signed-in user. */
  isAdmin: (user: User) => Promise<boolean>;
}

/**
 * Who may read a cover. The owner and named admins may read any cover of the story, whatever its state (draft, pending, rejected,
 * withdrawn). Everyone else, signed in or not, may read only the current cover of a story that is approved and published. Every
 * other request is answered as a missing cover, so the route does not reveal which stories exist.
 */
export async function mayReadCover(deps: CoverReadDeps, user: User | undefined, owner: string, hauntId: string, key: string): Promise<boolean> {
  const record = await deps.stories.get(owner, hauntId);
  if (!record) return false;
  if (user && user.sub === owner) return true;
  if (user && (await deps.isAdmin(user))) return true;
  if (record.status !== "published" || record.publishedKey !== "published") return false;
  // Only the approved revision's cover is public. A pending revision's cover is not, even if it is the working copy's.
  const pub = publicRevisionOf(record);
  if (!pub || pub.story.coverUrl !== coverPath(key)) return false;
  // Published before approval records existed, and still on their original revision (grandfathered): public without a record.
  if ((pub as { legacy?: true; grandfathered?: true }).legacy || (pub as { grandfathered?: true }).grandfathered) return true;
  if (!deps.approvals) return false;
  const submission = await deps.approvals.get(submissionIdFor(hauntId, pub.version));
  return submission?.status === "APPROVED";
}

/** Serves a cover. The server reads the object and streams it; no S3 address or signed link ever reaches the browser. */
export function createCoverRouter(deps: CoverReadDeps): Router {
  const router = Router();
  router.get("/covers/:owner/:hauntId/:file", async (req, res) => {
    const owner = String(req.params.owner);
    const hauntId = String(req.params.hauntId);
    const key = `covers/${owner}/${hauntId}/${String(req.params.file)}`;
    if (!deps.storage) return void res.status(503).json({ error: "Cover images aren't set up on this server." });
    if (!isValidCoverKey(key)) return void res.status(404).json({ error: "No such cover." });
    try {
      if (!(await mayReadCover(deps, userOf(res), owner, hauntId, key))) return void res.status(404).json({ error: "No such cover." });
      const body = await deps.storage.read(key);
      if (!body) return void res.status(404).json({ error: "No such cover." });
      res.set({
        "Content-Type": COVER_CONTENT_TYPE[key.slice(key.lastIndexOf(".") + 1)]!,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      body.on("error", (error) => {
        console.error("[covers] stream failed:", (error as Error).name);
        res.destroy();
      });
      body.pipe(res);
    } catch (error) {
      console.error("[covers] read failed:", (error as Error).name);
      res.status(503).json({ error: "Cover images aren't available right now." });
    }
  });
  return router;
}

/** Failures of the approval workflow, in the same shape as the story routes. */
function approvalFail(res: Response, error: ApprovalError) {
  const status = { not_found: 404, forbidden: 403, invalid: 422, conflict: 409, stale: 409 }[error.code];
  return void res.status(status).json({ error: error.message, problems: error.problems });
}

/**
 * Everything under /api/me/user-stories, as mounted by index.ts: a verified session first, then the routes. Any signed-in
 * user can list, create and edit their own stories (drafts). Submitting for review needs a creator role (CREATOR or ADMIN,
 * roles.ts), checked per route in createMyStoriesRouter. An unauthenticated request gets 401.
 */
export function createCreatorStoryRouter(options: {
  authenticate: Authenticator;
  profiles: ProfileStore | undefined;
  store: UserStoryStore | undefined;
  limiter: RateLimiter;
  covers?: CoverStorage;
  approvals?: StoryApprovalStore;
  generate?: SettingsGenerator;
}): Router {
  const router = Router();
  router.use(identify(options.authenticate));
  router.use(
    createMyStoriesRouter(
      options.store,
      options.limiter,
      options.covers,
      options.approvals,
      requireRole(options.profiles, CREATOR_ROLES),
      options.generate,
    ),
  );
  return router;
}

/**
 * `creatorGate` guards the routes that send a story toward the library (submit). Creators' rights are checked there,
 * never by the caller's identity alone. Mounted through createCreatorStoryRouter, which supplies the real gate.
 */
export function createMyStoriesRouter(
  store: UserStoryStore | undefined,
  limiter: RateLimiter,
  covers?: CoverStorage,
  approvals?: StoryApprovalStore,
  creatorGate?: RequestHandler,
  generate?: SettingsGenerator,
): Router {
  const router = Router();
  const unavailable = (res: Response) => res.status(503).json({ error: "Stories aren't available on this server." });
  const signIn = (res: Response) => res.status(401).json({ error: "Sign in to see and make your stories." });

  /** Per-user limit for writes, so one account can't flood the table. */
  function allowWrite(res: Response, userId: string): boolean {
    const verdict = limiter.hit(`my-stories:${userId}`);
    if (verdict.ok) return true;
    res.set("Retry-After", String(verdict.retryAfterSeconds)).status(429).json({ error: "Too many changes. Wait a moment." });
    return false;
  }

  router.use((req, res, next) => {
    if (!store) return void unavailable(res);
    if (!userOf(res)) return void signIn(res);
    if (req.method !== "GET" && !allowWrite(res, userOf(res)!.sub)) return;
    next();
  });

  router.get("/", async (_req, res) => {
    try {
      res.json({ stories: await store!.listFor(userOf(res)!.sub) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post("/", async (req, res) => {
    const parsed = StoryInputSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    try {
      res.status(201).json({ story: await store!.create(userOf(res)!.sub, parsed.data) });
    } catch (error) {
      fail(res, error);
    }
  });

  /** The creator's submissions across all their stories, for the status on each My Stories card. Before "/:hauntId" below. */
  router.get("/review-status", async (_req, res) => {
    if (!approvals) return void unavailable(res);
    try {
      res.json({ submissions: await approvals.listForCreator(userOf(res)!.sub) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/:hauntId", async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    try {
      const story = await store!.get(userOf(res)!.sub, hauntId);
      if (!story) return void res.status(404).json({ error: "No such story." });
      res.json({ story });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put("/:hauntId", async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    const parsed = StoryInputSchema.and(VersionSchema).safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const { expectedVersion, ...input } = parsed.data;
    try {
      if (input.coverUrl.startsWith("/api/covers/")) {
        // Ownership first, so a story that isn't the caller's gets the same answer as a missing one.
        if (!(await store!.get(userOf(res)!.sub, hauntId))) return void res.status(404).json({ error: "No such story." });
        const coverProblemText = await coverSaveProblem(covers, userOf(res)!.sub, hauntId, input.coverUrl);
        if (coverProblemText) return void res.status(422).json({ error: coverProblemText, problems: [coverProblemText] });
      }
      const owner = userOf(res)!.sub;
      const saved = await store!.update(owner, hauntId, StoryInputSchema.parse(input), expectedVersion);
      // An edit makes any pending review out of date: its story is no longer the reviewed revision, so it is withdrawn.
      await approvals?.withdrawPending(owner, hauntId, "The story was edited after it was submitted. Submit it again to review.");
      res.json({ story: saved });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Asks for permission to upload a cover. The story must be the caller's. Answers a presigned POST that the browser sends the file
   * to directly; the file never passes through this server.
   */
  router.post("/:hauntId/cover", async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    if (!covers) return void res.status(503).json({ error: "Cover uploads aren't set up on this server." });
    const parsed = CoverRequestSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(422).json({ error: "Choose a JPEG, PNG or WebP image under 5 MB." });
    try {
      const owner = userOf(res)!.sub;
      if (!(await store!.get(owner, hauntId))) return void res.status(404).json({ error: "No such story." });
      const key = coverKey(owner, hauntId, parsed.data.contentType);
      const upload = await covers.presignUpload(key, parsed.data.contentType);
      res.json({ ...upload, coverUrl: coverPath(key), expiresIn: UPLOAD_TTL_SECONDS });
    } catch (error) {
      console.error("[covers] upload request failed:", (error as Error).name);
      res.status(503).json({ error: "Cover uploads aren't available right now. Try again in a moment." });
    }
  });

  router.post("/:hauntId/preview", async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    try {
      res.json(await store!.preview(userOf(res)!.sub, hauntId));
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Regenerates the draft from its sub-genre settings. The approved copy (publicStory) is kept by store.update, so Community
   * keeps showing it until an admin approves this new draft. Body: the version this is based on, the premise, and the settings.
   */
  router.post("/:hauntId/regenerate", async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    if (!generate) return void res.status(503).json({ error: "Story generation isn't available on this server." });
    const parsed = z
      .object({ expectedVersion: z.number().int().min(1), premise: z.string().trim().min(1).max(500), settings: StorySettingsSchema })
      .safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    try {
      const owner = userOf(res)!.sub;
      const current = await store!.get(owner, hauntId);
      if (!current) return void res.status(404).json({ error: "No such story." });
      // A hand-written story has scenes no settings can rebuild. Regenerating it would replace them, so it is refused.
      if (!current.story.settings) {
        return void res.status(422).json({ error: "This story was written by hand, so it can't be regenerated. Edit its scenes instead." });
      }
      const { title, segments } = await generate(parsed.data.settings, parsed.data.premise);
      const input = StoryInputSchema.safeParse({
        ...current.story,
        title,
        premise: parsed.data.premise,
        segments,
        settings: parsed.data.settings,
      });
      if (!input.success) return void res.status(422).json({ error: z.prettifyError(input.error) });
      res.json({ story: await store!.update(owner, hauntId, input.data, parsed.data.expectedVersion) });
    } catch (error) {
      if (error instanceof GenerationError) return void res.status(502).json({ error: error.message });
      fail(res, error);
    }
  });

  // Stories go public only through an admin's approval (story-approvals.ts). Creators can submit, and can take a story down.
  router.post("/:hauntId/publish", (_req, res) =>
    void res.status(403).json({ error: "Stories go public only after an admin approves them. Submit it for approval instead." }),
  );

  router.post("/:hauntId/unpublish", async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    const parsed = VersionSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Send the version you are publishing from." });
    try {
      res.json({ story: await store!.unpublish(userOf(res)!.sub, hauntId, parsed.data.expectedVersion) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/:hauntId/submissions", async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    if (!approvals) return void unavailable(res);
    try {
      const owner = userOf(res)!.sub;
      const mine = (await approvals.listForStory(hauntId)).filter((s) => s.submittedBy === owner);
      res.json({ submissions: mine });
    } catch (error) {
      fail(res, error);
    }
  });

  /** Submits the story's current revision for admin review. Nothing becomes public here. */
  router.post("/:hauntId/submit", creatorGate ?? ((_req, _res, next) => next()), async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    if (!approvals) return void unavailable(res);
    try {
      const owner = userOf(res)!.sub;
      const record = await store!.get(owner, hauntId);
      if (!record) return void res.status(404).json({ error: "No such story." });
      const coverProblemText = await coverSaveProblem(covers, owner, hauntId, record.story.coverUrl);
      if (coverProblemText) return void res.status(422).json({ error: coverProblemText, problems: [coverProblemText] });
      const submission = await approvals.submit(owner, hauntId);
      res.status(201).json({ submission });
    } catch (error) {
      if (error instanceof ApprovalError) return void approvalFail(res, error);
      fail(res, error);
    }
  });

  router.delete("/:hauntId", async (req, res) => {
    const hauntId = String(req.params.hauntId);
    if (!HAUNT_ID.test(hauntId)) return void res.status(404).json({ error: "No such story." });
    try {
      await store!.remove(userOf(res)!.sub, hauntId);
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}

export function createCommunityRouter(library: Library, store: UserStoryStore | undefined): Router {
  const router = Router();

  router.get("/stories", async (_req, res) => {
    try {
      const haunt = (await library.list()).map((entry) => ({
        id: entry.episode.storyId,
        kind: "haunt" as const,
        title: entry.episode.title,
        synopsis: entry.summary,
        author: entry.creator,
        genre: entry.genre ?? "",
        atmosphere: "",
        coverUrl: "",
        publishedAt: entry.publishedAt,
        minutes: entry.episode.estimatedMinutes,
      }));
      const community = store ? await store.listPublished(LIST_LIMIT) : { stories: [], truncated: false };
      const stories = [...haunt, ...community.stories.map((card) => ({ ...card, kind: "community" as const }))].sort((a, b) =>
        b.publishedAt.localeCompare(a.publishedAt),
      );
      res.json({ stories, truncated: community.truncated });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get("/stories/:id", async (req, res) => {
    const id = String(req.params.id);
    try {
      if (HAUNT_ID.test(id)) {
        const record = store ? await store.findPublished(id) : undefined;
        if (!record) return void res.status(404).json({ error: "No such story." });
        // Playback is the approved revision, never the creator's pending working copy.
        const pub = publicRevisionOf(record as UserStoryRecord)?.story ?? record.story;
        return void res.json({ kind: "community", card: communityCard(record), episode: { ...episodeFor(id, pub), creator: creatorOf(record) } });
      }
      const entry = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? await library.get(id) : undefined;
      if (!entry) return void res.status(404).json({ error: "No such story." });
      res.json({ kind: "haunt", episode: entry.episode });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
