import { Router, type Response } from "express";
import { z } from "zod";
import { userOf } from "./auth.ts";
import type { EngagementStore } from "./engagement.ts";
import type { Library } from "./library.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { PlayMode, Progress, ViewingStore } from "./viewing.ts";
import { newerProgress, type LikeRecord, type ProgressRecord, type SplitStore } from "./split-records.ts";
import { mainPath } from "@firetales/core";

/**
 * The signed-in listener's own viewing: Continue Watching and My Likes. The user comes from the verified session, never from
 * the request, so nobody can read or change someone else's record. Guests get a 401 with a sign-in message.
 *
 *   GET /api/me/library                       unfinished stories (most recently watched first) and liked stories
 *   PUT /api/me/library/progress/:storyId     save a checkpoint: { partIndex, completed? }
 *   PUT /api/me/library/mode/:storyId         remember the play mode: { mode: "choices" | "listen" }
 *
 * Progress is a checkpoint at a part (the segment the listener is on). Resume restarts that part; it isn't mid-sentence.
 * The part count comes from the published story's main storyline, not from the request. Only the final part can be marked
 * completed. A part index counts along that main storyline, so a listen resume lands on the same part it was saved at.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isPrefix = (part: number[], whole: number[]) => part.length <= whole.length && part.every((value, i) => whole[i] === value);
const LIMIT = 50;
/** The longest a story's narration can run. The server doesn't hold the player's timeline, so this is only a sanity bound. */
const MAX_POSITION_MS = 6 * 60 * 60 * 1000;

/** Legacy progress and the new records, one per story. The newer lastPlayedAt wins (newerProgress). */
function mergeProgress(legacy: Record<string, Progress>, fresh: ProgressRecord[]): Record<string, ProgressView> {
  const out: Record<string, ProgressView> = {};
  const freshById = new Map(fresh.map((r) => [r.hauntId, r]));
  for (const storyId of new Set([...Object.keys(legacy), ...freshById.keys()])) {
    const f = freshById.get(storyId);
    const chosen = newerProgress<Progress>(f && toProgress(f), legacy[storyId]);
    // The version belongs to the new record (0 when there is none), so a save can be checked against what is stored.
    if (chosen) out[storyId] = { ...chosen, version: f?.version ?? 0 };
  }
  return out;
}

/** A progress checkpoint as the client sees it. `version` is what the next save must send as expectedVersion. */
type ProgressView = Progress & { version: number };

function toProgress(r: ProgressRecord): Progress {
  return {
    partIndex: r.partIndex,
    positionMs: r.positionMs,
    totalParts: r.totalParts,
    completed: r.completed,
    lastPlayedAt: r.lastPlayedAt,
    ...(r.completedAt ? { completedAt: r.completedAt } : {}),
    ...(r.mode ? { mode: r.mode } : {}),
    ...(r.segment !== undefined ? { segment: r.segment } : {}),
    ...(r.history ? { history: r.history } : {}),
  };
}

/**
 * The mode a Continue Watching entry resumes in. It is the mode the progress itself was saved with. The remembered play
 * mode (state.modes, what the play-mode question preselects) is not progress, so it never stands in for a missing one:
 * an older record without its own mode resumes from its saved position instead of looking like a branch run.
 */
export function storedMode(progressMode: "choices" | "listen" | null | undefined): "choices" | "listen" | null {
  return progressMode ?? null;
}

/**
 * The liked stories as { storyId: likedAt }. A new record decides a story it covers: a like keeps its own timestamp; a tombstone
 * removes the story unless the legacy like is newer than the unlike.
 */
function mergeLikes(legacy: Record<string, string>, fresh: LikeRecord[]): Record<string, string> {
  const out: Record<string, string> = { ...legacy };
  for (const r of fresh) {
    const legacyAt = legacy[r.hauntId];
    if (r.liked) out[r.hauntId] = r.createdAt;
    else if (legacyAt !== undefined && legacyAt > r.updatedAt) out[r.hauntId] = legacyAt;
    else delete out[r.hauntId];
  }
  return out;
}

export function createMyLibraryRouter(
  viewing: ViewingStore | undefined,
  library: Library,
  engagement: EngagementStore | undefined,
  limiter: RateLimiter,
  split?: SplitStore,
  /** Likes are read from haunt-likes in every mode, so a like written there always shows in My Likes. */
  likeStore?: SplitStore,
): Router {
  const router = Router();

  const unavailable = (res: Response) => res.status(503).json({ error: "Your viewing history isn't available on this server." });
  const signIn = (res: Response) => res.status(401).json({ error: "Sign in to see your stories and likes." });

  router.get("/", async (_req, res) => {
    const user = userOf(res);
    if (!user) return void signIn(res);
    if (!viewing) return void unavailable(res);
    try {
      const state = await viewing.get(user.sub);
      // Dual read (split mode only): the new tables first, the legacy maps for stories with no new record. See split-records.ts.
      const progress: Record<string, ProgressView> = split
        ? mergeProgress(state.progress, await split.progressRecords(user.sub))
        : Object.fromEntries(Object.entries(state.progress).map(([storyId, p]) => [storyId, { ...p, version: 0 }]));
      const likedMap = likeStore ? mergeLikes(state.likes, await likeStore.likeRecords(user.sub)) : state.likes;
      const continueWatching = [];
      const unfinished = Object.entries(progress)
        .filter(([, p]) => !p.completed)
        .sort(([, a], [, b]) => b.lastPlayedAt.localeCompare(a.lastPlayedAt))
        .slice(0, LIMIT);
      for (const [storyId, p] of unfinished) {
        const entry = SAFE_ID.test(storyId) ? await library.get(storyId) : undefined;
        if (!entry) continue; // unpublished since: not shown
        const totalParts = mainPath(entry.episode.segments).length;
        continueWatching.push({
          storyId,
          title: entry.episode.title,
          summary: entry.summary,
          minutes: entry.episode.estimatedMinutes,
          partIndex: Math.min(p.partIndex, totalParts - 1),
          positionMs: p.positionMs ?? 0,
          totalParts,
          lastPlayedAt: p.lastPlayedAt,
          version: p.version,
          mode: storedMode(p.mode),
          segment: p.segment ?? null,
          history: p.history ?? null,
          // A choices run is "on the main storyline" while its history is a prefix of the main path. Only then does
          // "Part N of M" use the main path's length; a branch shows its own part number instead.
          onMainPath: p.history ? isPrefix(p.history, mainPath(entry.episode.segments)) : true,
        });
      }

      const liked = Object.entries(likedMap)
        .sort(([, a], [, b]) => b.localeCompare(a))
        .slice(0, LIMIT);
      const likes = [];
      for (const [storyId, likedAt] of liked) {
        const entry = SAFE_ID.test(storyId) ? await library.get(storyId) : undefined;
        if (!entry) continue;
        const counts = engagement ? await engagement.counts(storyId) : null;
        likes.push({
          storyId,
          title: entry.episode.title,
          summary: entry.summary,
          creator: entry.creator,
          minutes: entry.episode.estimatedMinutes,
          likedAt,
          likes: counts?.likes ?? null,
          plays: counts?.plays ?? null,
        });
      }
      res.json({ continueWatching, likes, modes: state.modes });
    } catch (error) {
      console.error("[me-library] read failed:", (error as Error).name);
      unavailable(res);
    }
  });

  const ProgressSchema = z.object({
    partIndex: z.number().int().min(0).max(999),
    positionMs: z.number().int().min(0).max(MAX_POSITION_MS).optional(),
    completed: z.boolean().optional(),
    mode: z.enum(["choices", "listen"]).optional(),
    segment: z.number().int().min(0).max(999).optional(),
    history: z.array(z.number().int().min(0).max(999)).max(500).optional(),
    // The version the client last saw (from GET or the previous save). Missing means "no version check".
    expectedVersion: z.number().int().min(0).max(1_000_000_000).optional(),
  });
  router.put("/progress/:storyId", async (req, res) => {
    const user = userOf(res);
    if (!user) return void signIn(res);
    if (!viewing) return void unavailable(res);
    const verdict = limiter.hit(`progress:${user.sub}`);
    if (!verdict.ok) {
      res.set("Retry-After", String(verdict.retryAfterSeconds)).status(429).json({ error: "Too many saves. Wait a moment." });
      return;
    }
    const parsed = ProgressSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const storyId = String(req.params.storyId);
    const entry = SAFE_ID.test(storyId) ? await library.get(storyId) : undefined;
    if (!entry) return void res.status(404).json({ error: "No such story." });
    const totalParts = mainPath(entry.episode.segments).length;
    const { partIndex, completed = false, mode, segment, history, expectedVersion } = parsed.data;
    const positionMs = parsed.data.positionMs ?? 0;
    const segments = entry.episode.segments;
    // A branch can be longer than the main storyline, so its part number is bounded by the whole story instead.
    const partLimit = history ? segments.length : totalParts;
    if (partIndex >= partLimit) return void res.status(400).json({ error: "That part isn't in this story." });
    // A branch is valid only if every segment on it exists and the last one is where the listener is.
    if (segment !== undefined && segment >= segments.length) return void res.status(400).json({ error: "That part isn't in this story." });
    if (history && history.some((i) => i >= segments.length)) return void res.status(400).json({ error: "That path isn't in this story." });
    if (history && segment !== undefined && history[history.length - 1] !== segment) {
      return void res.status(400).json({ error: "The current part must be the last one on the path." });
    }
    // A story completes only where it really ends: an ending segment, or the last part of a story without endings marked.
    const position = segment ?? mainPath(segments)[partIndex];
    const storyMarksEndings = segments.some((s) => s.ending === true);
    const endsHere = position !== undefined && (segments[position]?.ending === true || (!storyMarksEndings && partIndex === totalParts - 1));
    if (completed && !endsHere) return void res.status(400).json({ error: "A story is completed only at an ending." });
    try {
      if (split) {
        // Dual mode: one item per user and story in haunt-progress. A save that is older than the stored one is refused (stale).
        const stamp = new Date().toISOString();
        const result = await split.saveProgress(
          {
            userId: user.sub,
            hauntId: storyId,
            partIndex,
            totalParts,
            positionMs,
            completed,
            lastPlayedAt: stamp,
            ...(completed ? { completedAt: stamp } : {}),
            ...(mode ? { mode } : {}),
            ...(segment !== undefined ? { segment } : {}),
            ...(history ? { history } : {}),
          },
          expectedVersion,
        );
        if (!result.applied) {
          // Refused, never reported as saved. The client reloads its progress instead of replaying its own.
          return void res.status(409).json({
            ok: false,
            stale: true,
            error: "Your progress changed on another device. Reload to continue from the saved point.",
            version: result.current?.version ?? 0,
            partIndex: result.current?.partIndex ?? null,
          });
        }
        return void res.json({
          ok: true,
          partIndex,
          positionMs,
          totalParts,
          completed,
          stale: false,
          // An unversioned save replaces the item without a version, which reads back as 0 (see GET and saveProgress).
          version: expectedVersion === undefined ? 0 : expectedVersion + 1,
        });
      }
      await viewing.saveProgress(user.sub, storyId, { partIndex, positionMs, totalParts, completed, mode, segment, history });
      res.json({ ok: true, partIndex, positionMs, totalParts, completed });
    } catch (error) {
      console.error("[me-library] save failed:", (error as Error).name);
      unavailable(res);
    }
  });

  const ModeSchema = z.object({ mode: z.enum(["choices", "listen"]) });
  router.put("/mode/:storyId", async (req, res) => {
    const user = userOf(res);
    if (!user) return void signIn(res);
    if (!viewing) return void unavailable(res);
    const parsed = ModeSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
    const storyId = String(req.params.storyId);
    const entry = SAFE_ID.test(storyId) ? await library.get(storyId) : undefined;
    if (!entry) return void res.status(404).json({ error: "No such story." });
    try {
      await viewing.setMode(user.sub, storyId, parsed.data.mode as PlayMode);
      res.json({ ok: true, storyId, mode: parsed.data.mode });
    } catch (error) {
      console.error("[me-library] mode save failed:", (error as Error).name);
      unavailable(res);
    }
  });

  return router;
}
