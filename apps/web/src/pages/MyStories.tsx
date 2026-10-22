import { useCallback, useEffect, useState } from "react";
import { session, useSession, type SessionState } from "../lib/session.ts";
import { Link, navigate } from "../router.tsx";
import { CreatorAccessPanel } from "../components/CreatorAccessPanel.tsx";
import { StoryListSkeleton } from "../components/StoryListSkeleton.tsx";
import { myRole } from "../lib/creator-access.ts";

interface MyStory {
  storyId: string;
  title: string;
  premise: string;
  status: "active" | "completed";
  scenes: number;
  targetScenes: number;
  lastQuestion: string | null;
  updatedAt: string;
  review: {
    status: "submitted" | "approved" | "rejected";
    creator: string;
    summary: string;
    reason: string | null;
  } | null;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await session.fetch(`/api/me${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-Haunt-Client": "web", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

const REVIEW_LABEL = { submitted: "Waiting for review", approved: "In the library", rejected: "Not accepted" } as const;

/** Signed in, or (local development without a user pool) the browser's development id. */
const hasAccount = (state: SessionState) => state.status === "signed-in" || (import.meta.env.DEV && state.status === "guest" && !state.available);

/** The listener's own stories: every turn is saved as it happens, so any of them can be resumed. */
export function MyStories() {
  const state = useSession();
  const identified = hasAccount(state);
  const [stories, setStories] = useState<MyStory[]>();
  const [refreshing, setRefreshing] = useState(false);
  // The role comes from the server's profile record. Only Creators and admins see submit controls.
  const [isCreator, setIsCreator] = useState(false);
  useEffect(() => {
    if (!identified) return;
    myRole()
      .then((role) => setIsCreator(role === "CREATOR" || role === "ADMIN"))
      .catch(() => setIsCreator(false));
  }, [identified]);
  const [error, setError] = useState<string>();
  const [guestCount, setGuestCount] = useState(0);
  const [claimNote, setClaimNote] = useState<string>();
  // A refresh keeps the list on screen and shows a small "Refreshing…" label until it finishes or fails.
  const load = useCallback(() => {
    setRefreshing(true);
    return api<{ stories: MyStory[] }>("/stories")
      .then((data) => setStories(data.stories))
      .catch((e: Error) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, []);
  useEffect(() => {
    if (!identified) return;
    void load();
    api<{ count: number }>("/guest-stories")
      .then((data) => setGuestCount(data.count))
      .catch(() => setGuestCount(0));
  }, [load, identified]);

  const claim = async () => {
    try {
      const result = await api<{ claimed: number; remaining: number }>("/claim-guest-stories", {});
      setGuestCount(result.remaining);
      setClaimNote(`Moved ${result.claimed} ${result.claimed === 1 ? "story" : "stories"} into your account.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page">
      {identified && <CreatorAccessPanel />}
      <header className="page-head">
        <span className="eyebrow">My stories</span>
        <h1>Your stories</h1>
        <p className="lede">Private to you. Every turn is saved as you go, so you can pick up where you left off.</p>
      </header>
      {state.status === "loading" && <p className="muted">Loading…</p>}
      {!identified && state.status === "guest" && (
        <div className="card empty-state">
          {state.available ? (
            <>
              <p>Sign in to keep your stories and pick them up on any device. Guests can still play; their stories stay on this browser.</p>
              <Link className="button primary" href="/sign-in?next=/my-stories">
                Sign in
              </Link>
            </>
          ) : (
            <p>Accounts aren't available on this server yet, so stories aren't saved to an account.</p>
          )}
        </div>
      )}
      {identified && guestCount > 0 && (
        <p className="publish-notice" role="status">
          You played {guestCount} {guestCount === 1 ? "story" : "stories"} as a guest on this browser.{" "}
          <button type="button" className="button small" onClick={() => void claim()}>
            Keep {guestCount === 1 ? "it" : "them"} in my account
          </button>
        </p>
      )}
      {claimNote && <p className="publish-notice" role="status">✓ {claimNote}</p>}
      {error && <p className="error">{error}</p>}
      {identified && !stories && !error && <StoryListSkeleton />}
      {stories?.length === 0 && (
        <div className="card empty-state">
          <p>No stories yet.</p>
          <button type="button" className="button" onClick={() => navigate("/alexa")}>
            Start one
          </button>
        </div>
      )}
      {refreshing && stories && (
        <p className="refresh-indicator" role="status">
          <span className="refresh-dot" aria-hidden="true" />
          Refreshing…
        </p>
      )}
      <div className="admin-list">
        {stories?.map((story) => <MyStoryRow key={story.storyId} story={story} onChange={load} creator={isCreator} />)}
      </div>
    </div>
  );
}

/**
 * One of the listener's stories. Submitting is a Creator action (the server refuses it otherwise), so the button only
 * appears for Creators; a completed story that isn't approved yet is eligible, and the server checks ownership again.
 */
function MyStoryRow({ story, onChange, creator: isCreator }: { story: MyStory; onChange: () => Promise<void>; creator: boolean }) {
  const [creator, setCreator] = useState(story.review?.creator ?? "");
  const [summary, setSummary] = useState(story.review?.summary ?? "");
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  // Eligible: finished (completed), owned by this account, and not already in the library.
  const canSubmit = isCreator && story.status === "completed" && story.review?.status !== "approved";

  const submit = async () => {
    setWorking(true);
    setError(undefined);
    try {
      await api(`/stories/${encodeURIComponent(story.storyId)}/submit`, { creator, summary });
      setOpen(false);
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <article className="card admin-story">
      <header>
        <h2>{story.title}</h2>
        <span className={`badge${story.status === "active" ? " quiet" : ""}`}>
          {story.status === "active" ? `Turn ${story.scenes} of ${story.targetScenes}` : "Finished"}
        </span>
        {story.review && <span className="badge quiet">{REVIEW_LABEL[story.review.status]}</span>}
      </header>
      <p className="muted">
        {story.premise} · last played {new Date(story.updatedAt).toLocaleString()}
      </p>
      {story.lastQuestion && <p className="admin-excerpt">“{story.lastQuestion}”</p>}
      {story.review?.status === "rejected" && story.review.reason && (
        <p className="admin-similar" role="note">
          Reviewer’s note: {story.review.reason}
        </p>
      )}
      <div className="admin-actions">
        <button type="button" className="button primary" onClick={() => navigate(`/alexa?resume=${encodeURIComponent(story.storyId)}`)}>
          {story.status === "active" ? "Resume" : "Replay the ending"}
        </button>
        {canSubmit && !open && (
          <button type="button" className="button" onClick={() => setOpen(true)}>
            {story.review?.status === "submitted" ? "Edit submission" : story.review ? "Submit again" : "Submit to the library"}
          </button>
        )}
      </div>
      {open && (
        <form
          className="admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={`creator-${story.storyId}`}>Credit me as (a pen name, not your real name)</label>
          <input id={`creator-${story.storyId}`} value={creator} maxLength={40} onChange={(e) => setCreator(e.target.value)} />
          <label htmlFor={`summary-${story.storyId}`}>Library summary</label>
          <textarea
            id={`summary-${story.storyId}`}
            value={summary}
            maxLength={280}
            rows={2}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One or two sentences that make someone want to listen."
          />
          <button type="submit" className="button primary" disabled={working || !creator.trim() || !summary.trim()}>
            Submit for review
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </article>
  );
}
