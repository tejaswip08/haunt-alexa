import { useEffect, useRef } from "react";

/**
 * Likes and play counts for published stories (the server's /api/library routes, see docs/ENGAGEMENT.md).
 * The server's numbers are the only ones shown; nothing here stores a count.
 */
export interface StoryTotals {
  likes: number;
  plays: number;
}

export interface StoryStats extends StoryTotals {
  liked: boolean;
}

export class EngagementError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The answer's body (a 409 on progress carries the current version). */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new EngagementError(data.error ?? "That didn't work. Try again.", response.status, data);
  return data;
}

/** Totals for several stories at once, keyed by storyId. Unpublished or unknown ids are simply absent. */
export async function fetchTotals(storyIds: string[]): Promise<Record<string, StoryTotals>> {
  if (storyIds.length === 0) return {};
  const data = await call<{ stats: Record<string, StoryTotals> }>(`/api/library/stats?ids=${encodeURIComponent(storyIds.join(","))}`);
  return data.stats;
}

/** One story's totals, plus whether the signed-in caller likes it. */
export function fetchStoryStats(storyId: string): Promise<StoryStats> {
  return call<StoryStats>(`/api/library/${encodeURIComponent(storyId)}/stats`);
}

/** Sets the caller's like to `liked`. Idempotent: setting the same state twice changes nothing on the server. */
export async function setStoryLiked(storyId: string, liked: boolean): Promise<StoryStats> {
  const data = await call<StoryTotals & { liked: boolean }>(`/api/library/${encodeURIComponent(storyId)}/like`, {
    method: liked ? "PUT" : "DELETE",
  });
  return { likes: data.likes, plays: data.plays, liked: data.liked };
}

/**
 * Records one playback start. Pass the same playId to retry a failed call: the server counts it at most once.
 * Each new playback session gets a new playId (newPlayId).
 */
export function recordPlay(storyId: string, playId: string): Promise<StoryTotals & { counted: boolean }> {
  return call(`/api/library/${encodeURIComponent(storyId)}/plays`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playId }),
  });
}

/** A random id for one playback session. Uses getRandomValues, which works on plain http too (randomUUID doesn't). */
export function newPlayId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Calls `task` every `intervalMs` while `active` and the tab is visible, and once when the tab becomes visible again.
 * Stops when `active` turns false or the component unmounts, so no polling runs on a screen that isn't showing.
 */
export function usePoll(task: () => void, intervalMs: number, active = true) {
  const latest = useRef(task);
  latest.current = task;
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs, active]);
}

/** The polling interval for story totals, in milliseconds. A deliberate trade-off: see docs/ENGAGEMENT.md. */
export const TOTALS_POLL_MS = 10_000;

/**
 * Counts one genuine playback start: call it when narration of a new session begins. The retry reuses the same playId,
 * so a failed-then-retried request can't count twice. Fire and forget: the play count never blocks listening.
 */
export function countPlayStart(storyId: string) {
  const playId = newPlayId();
  const attempt = (retriesLeft: number) =>
    recordPlay(storyId, playId).catch(() => {
      if (retriesLeft > 0) window.setTimeout(() => attempt(retriesLeft - 1), 3_000);
    });
  void attempt(1);
}

/** Remembers the play mode the listener picked for a story (per account). Signed out, the server refuses and nothing is kept. */
export function setPlayMode(storyId: string, mode: "choices" | "listen"): Promise<void> {
  return call<{ ok: boolean }>(`/api/me/library/mode/${encodeURIComponent(storyId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  })
    .then(() => undefined)
    .catch(() => undefined);
}

/** One unfinished story in the account's Continue Watching, as GET /api/me/library returns it. */
export interface WatchingEntry {
  storyId: string;
  title: string;
  summary: string;
  minutes: number;
  partIndex: number;
  positionMs: number;
  totalParts: number;
  lastPlayedAt: string;
  mode: "choices" | "listen" | null;
  segment: number | null;
  history: number[] | null;
  /** For a choices run: whether it's on the main storyline (so "Part N of M" applies). */
  onMainPath: boolean;
  /** The progress version the next save must send as expectedVersion. */
  version?: number;
}

/** The signed-in listener's Continue Watching and the play mode they picked per story. Null for a signed-out visitor. */
export interface AccountLibrary {
  continueWatching: WatchingEntry[];
  /** Stories this account has liked (from its own record in DynamoDB), most recently liked first. */
  likes: { storyId: string; title: string; summary: string; creator: string; minutes: number; likedAt: string }[];
  modes: Record<string, "choices" | "listen">;
}

export async function fetchAccountLibrary(): Promise<AccountLibrary | null> {
  try {
    const library = await call<AccountLibrary>("/api/me/library");
    for (const item of library.continueWatching) progressVersions.set(item.storyId, item.version ?? 0);
    return library;
  } catch (error) {
    if (error instanceof EngagementError && error.status === 401) return null;
    throw error;
  }
}

/** Where the listener is in a story, saved to their account (so every device sees it). A failed save never stops playback. */
export interface ProgressSave {
  partIndex: number;
  positionMs?: number;
  completed?: boolean;
  mode?: "choices" | "listen";
  segment?: number;
  history?: number[];
}

/** Saves of one story go out one at a time, in the order they were made, so an older save can't land after a newer one. */
const progressQueues = new Map<string, Promise<void>>();
/** The progress version last seen for each story, sent as expectedVersion so a delayed save can't overwrite newer progress. */
const progressVersions = new Map<string, number>();
const RETRY_DELAYS_MS = [1500, 4000];

/** A save that failed in a way worth repeating: a network error, a server error, or a rate limit (after its wait). */
function transient(status: number | undefined) {
  return status === undefined || status >= 500 || status === 429;
}

/**
 * Saves where the listener is, to their account (so every device sees it). A transient failure is retried a couple of
 * times, in order; a rejected save is dropped and logged. The save never throws, so playback is never stopped by it.
 */
export function saveProgress(storyId: string, save: ProgressSave): Promise<void> {
  const send = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      // Read the version at each attempt, so a retry sends the version the server last reported.
      const expected = progressVersions.get(storyId);
      try {
        const saved = await call<{ version?: number }>(`/api/me/library/progress/${encodeURIComponent(storyId)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(expected === undefined ? save : { ...save, expectedVersion: expected }),
        });
        if (typeof saved.version === "number") progressVersions.set(storyId, saved.version);
        return;
      } catch (error) {
        const status = error instanceof EngagementError ? error.status : undefined;
        if (status === 409) {
          // Refused: newer progress is saved elsewhere. Keep that one; don't replay this save over it.
          const current = error instanceof EngagementError ? (error.data as { version?: number } | undefined) : undefined;
          if (typeof current?.version === "number") progressVersions.set(storyId, current.version);
          console.warn("[progress] not saved: newer progress exists");
          return;
        }
        // Signed out (401) or rejected (4xx other than 429): repeating can't help.
        if (!transient(status) || attempt >= RETRY_DELAYS_MS.length) {
          console.warn("[progress] not saved:", status ?? "network error");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      }
    }
  };
  const next = (progressQueues.get(storyId) ?? Promise.resolve()).then(send);
  progressQueues.set(storyId, next);
  return next;
}
