import { useEffect, useRef, useState } from "react";
import { EngagementError, fetchStoryStats, setStoryLiked, TOTALS_POLL_MS, usePoll, type StoryStats } from "../lib/engagement.ts";
import { useSession } from "../lib/session.ts";

/**
 * A story's play count and its Like button. Totals come from the server and refresh every few seconds while this is shown
 * (usePoll stops it when the screen closes). A like shows at once and is then replaced by the server's answer; if the
 * server refuses, the previous state comes back with a message.
 */
export function StoryEngagement({ storyId, focusable = false }: { storyId: string; focusable?: boolean }) {
  const account = useSession();
  const signedIn = account.status === "signed-in";
  const [stats, setStats] = useState<StoryStats>();
  const [error, setError] = useState<string>();
  // One like request at a time. Rapid taps are ignored, and polling doesn't overwrite an answer that's on its way.
  const busy = useRef(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let current = true;
    setStats(undefined);
    fetchStoryStats(storyId)
      .then((s) => current && !busy.current && setStats(s))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [storyId, signedIn]);

  usePoll(
    () => {
      if (busy.current) return;
      fetchStoryStats(storyId)
        .then((s) => !busy.current && setStats(s))
        .catch(() => {});
    },
    TOTALS_POLL_MS,
  );

  async function toggle() {
    if (!stats || busy.current || !signedIn) return;
    const before = stats;
    const liked = !before.liked;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setStats({ ...before, liked, likes: Math.max(0, before.likes + (liked ? 1 : -1)) });
    try {
      setStats(await setStoryLiked(storyId, liked));
    } catch (e) {
      setStats(before);
      setError(
        e instanceof EngagementError && e.status === 401
          ? "Sign in again to like this story."
          : "Your like couldn't be saved. Try again.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const likes = stats ? compact(stats.likes) : "—";
  const plays = stats ? compact(stats.plays) : "—";

  return (
    <div className="story-engagement">
      <span className="story-plays" title="How many times a playback has started">
        <PlayIcon />
        <span>{plays} plays</span>
      </span>
      <button
        type="button"
        className={`story-like${stats?.liked ? " is-liked" : ""}`}
        aria-pressed={stats?.liked ?? false}
        aria-label={`${stats?.liked ? "Unlike" : "Like"} this story. ${likes} likes.`}
        disabled={!stats || pending || !signedIn}
        onClick={() => void toggle()}
        data-focusable={focusable || undefined}
      >
        <HeartIcon filled={stats?.liked ?? false} />
        <span>{likes} likes</span>
      </button>
      {!signedIn && account.status !== "loading" && <span className="story-hint">Sign in to like stories</span>}
      {error && (
        <span className="story-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** 1.2K, 248: compact for large counts, plain for small ones. */
const compact = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <path
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        d="M12 21s-7.5-4.6-9.6-9.1C.9 8.6 2.6 5 6.2 5c2.1 0 3.4 1.2 4.2 2.4C11.2 6.2 12.5 5 14.6 5c3.6 0 5.3 3.6 3.8 6.9C19.5 16.4 12 21 12 21z"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path fill="currentColor" d="M10 8.5v7l5.5-3.5z" />
    </svg>
  );
}
