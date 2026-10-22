import { useCallback, useEffect, useState, type FormEvent } from "react";
import { publishAndOpenLibrary, type PublishResponse } from "../lib/admin-publish.ts";
import { session, useSession } from "../lib/session.ts";
import { Link, navigate } from "../router.tsx";
import { CreatorRequestQueue } from "../components/CreatorRequestQueue.tsx";
import { FeaturedTonightAdmin } from "../components/FeaturedTonightAdmin.tsx";
import { myRole } from "../lib/creator-access.ts";
import { StoryListSkeleton } from "../components/StoryListSkeleton.tsx";

interface FinishedStory {
  storyId: string;
  title: string;
  premise: string;
  scenes: number;
  finishedAt: string;
  published: boolean;
  /** Live pen name and summary, when already published. */
  creator?: string;
  summary?: string;
  opening: string;
  /** A signed-in listener's story: it reaches the library only by approving their submission. */
  fromListener?: boolean;
  review?: { status: "submitted" | "approved" | "rejected"; reason?: string } | null;
  /** Other library entries that would look like this one. */
  similar: { storyId: string; title: string; reason: "same content" | "same title" | "same premise" }[];
}

/** A failed admin request, keeping the server's response for callers that need details. */
class AdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
  }
}

const TOKEN_KEY = "haunt-admin-token";

function savedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Publishing desk. A signed-in admin (ADMIN role on the server profile, or a member of the legacy admin group while
 * that fallback is on) publishes with their session. The operator token is a fallback for when nobody is signed in.
 * The server makes the decision either way.
 */
export function Admin() {
  const account = useSession();
  const [profileAdmin, setProfileAdmin] = useState(false);
  const [token, setToken] = useState(savedToken);
  const [draftToken, setDraftToken] = useState("");
  const [stories, setStories] = useState<FinishedStory[]>();
  const [error, setError] = useState<string>();
  // The server's role for this account; the group flag alone isn't enough once roles replace the group.
  const signedIn = account.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return setProfileAdmin(false);
    myRole()
      .then((role) => setProfileAdmin(role === "ADMIN"))
      .catch(() => setProfileAdmin(false));
  }, [signedIn]);
  const signedInAdmin = signedIn && (profileAdmin || Boolean(account.user?.admin));

  const request = useCallback(
    async (path: string, body?: unknown) => {
      const init = { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined };
      const json: Record<string, string> = body ? { "Content-Type": "application/json" } : {};
      const response = signedInAdmin
        ? await session.fetch(`/api/admin${path}`, { ...init, headers: json })
        : await fetch(`/api/admin${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...json } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new AdminError(data.error ?? `Request failed (${response.status})`, response.status, data);
      return data;
    },
    [token, signedInAdmin],
  );

  const load = useCallback(async () => {
    if (!token && !signedInAdmin) return;
    try {
      setError(undefined);
      setStories((await request("/stories")).stories);
    } catch (e) {
      setError((e as Error).message);
      setStories(undefined);
    }
  }, [request, token, signedInAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const unlock = (event: FormEvent) => {
    event.preventDefault();
    try {
      sessionStorage.setItem(TOKEN_KEY, draftToken);
    } catch {
      // Private mode: keep the token for this page view only.
    }
    setToken(draftToken);
  };

  return (
    <div className="page">
      <header className="page-head">
        <span className="eyebrow">Publishing desk</span>
        <h1>Publish to the library</h1>
        <p className="lede">Finished stories appear here. Publishing exports the narration only: no questions, no listener answers.</p>
      </header>
      <CreatorRequestQueue />
      {signedInAdmin && <FeaturedTonightAdmin />}

      {!signedInAdmin && (!token || (error && !stories)) ? (
        <form className="card admin-unlock" onSubmit={unlock}>
          {account.available && (
            <p className="muted">
              Admins can <Link href="/sign-in?next=/admin">sign in</Link> instead. Or use the operator token:
            </p>
          )}
          <label htmlFor="admin-token">Admin token</label>
          <input
            id="admin-token"
            type="password"
            autoComplete="off"
            value={draftToken}
            onChange={(e) => setDraftToken(e.target.value)}
          />
          <button type="submit" className="button primary">
            Unlock
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      ) : (
        <>
          {error && <p className="error">{error}</p>}
          {!stories && <StoryListSkeleton caption="Gathering the stories…" />}
          {stories?.length === 0 && <p className="card muted">No finished stories yet. Play one to the end on the Play page.</p>}
          <div className="admin-list">
            {stories?.map((story) => (
              <StoryRow key={story.storyId} story={story} request={request} onChange={load} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StoryRow({
  story,
  request,
  onChange,
}: {
  story: FinishedStory;
  request: (path: string, body?: unknown) => Promise<unknown>;
  onChange: () => Promise<void>;
}) {
  const [creator, setCreator] = useState(story.creator ?? "A Haunt listener");
  // Starts empty: copying the premise made every story from the same idea look identical.
  const [summary, setSummary] = useState(story.summary ?? "");
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [duplicateOf, setDuplicateOf] = useState<string>();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const review = story.review?.status;
  const awaitingReview = story.fromListener && review === "submitted";
  // Listener stories can't be published until they're submitted; approved ones can be edited.
  const canPublish = !story.fromListener || review === "submitted" || review === "approved";

  const act = async (path: string, body: Record<string, unknown>) => {
    setWorking(true);
    setError(undefined);
    setNote(undefined);
    setDuplicateOf(undefined);
    try {
      const result = (await request(path, body)) as { action?: string; warnings?: FinishedStory["similar"] };
      if (result.action) {
        const similar = result.warnings?.length ? ` Looks like: ${result.warnings.map((w) => `"${w.title}" (${w.reason})`).join(", ")}.` : "";
        setNote(`${result.action === "updated" ? "Updated" : "Published"}.${similar}`);
      }
      setEditing(false);
      await onChange();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof AdminError && typeof e.data.duplicateOf === "string") setDuplicateOf(e.data.duplicateOf);
    } finally {
      setWorking(false);
    }
  };
  /** Publishes, then opens /library once the server confirms; on failure, stays here with the error. */
  const publish = async (allowDuplicate = false) => {
    setWorking(true);
    setError(undefined);
    setNote(undefined);
    setDuplicateOf(undefined);
    const outcome = await publishAndOpenLibrary(
      (path, body) => request(path, body) as Promise<PublishResponse>,
      navigate,
      { storyId: story.storyId, creator, summary, ...(allowDuplicate ? { allowDuplicate: true } : {}) },
      awaitingReview ? "/approve" : "/publish",
    );
    if (!outcome.ok) {
      setError(outcome.error);
      if (outcome.duplicateOf) setDuplicateOf(outcome.duplicateOf);
      setWorking(false);
    }
  };

  return (
    <article className="card admin-story">
      <header>
        <h2>{story.title}</h2>
        {story.published && <span className="badge">Published</span>}
        {story.fromListener && review && (
          <span className="badge quiet">{{ submitted: "Submitted for review", approved: "Approved", rejected: "Rejected" }[review]}</span>
        )}
        {story.fromListener && !review && <span className="badge quiet">Listener’s draft · not submitted</span>}
      </header>
      <p className="muted">
        {story.scenes} turns · finished {new Date(story.finishedAt).toLocaleString()} · <code>{story.storyId}</code>
      </p>
      <p className="admin-excerpt">{story.opening}</p>
      {story.similar.length > 0 && (
        <p className="admin-similar" role="note">
          ⚠ A different story in the library looks like this one:{" "}
          {story.similar.map((w) => `"${w.title}" (${w.reason}, ${w.storyId})`).join("; ")}. Give it a distinct summary so
          listeners can tell them apart.
        </p>
      )}
      {story.review?.status === "rejected" && story.review.reason && <p className="muted">Rejected: {story.review.reason}</p>}
      {!canPublish ? null : story.published && !editing ? (
        <div className="admin-actions">
          <button type="button" className="button" disabled={working} onClick={() => setEditing(true)}>
            Edit summary
          </button>
          <button type="button" className="button" disabled={working} onClick={() => act("/unpublish", { storyId: story.storyId })}>
            Unpublish
          </button>
        </div>
      ) : (
        <form
          className="admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <label htmlFor={`creator-${story.storyId}`}>Credit as (pseudonym)</label>
          <input id={`creator-${story.storyId}`} value={creator} maxLength={40} onChange={(e) => setCreator(e.target.value)} />
          <label htmlFor={`summary-${story.storyId}`}>Library summary</label>
          <textarea
            id={`summary-${story.storyId}`}
            value={summary}
            maxLength={280}
            rows={2}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One or two sentences that make someone want to listen, different from other stories."
          />
          <button type="submit" className="button primary" disabled={working || !creator.trim() || !summary.trim()}>
            {awaitingReview ? "Approve and publish" : story.published ? "Update" : "Publish"}
          </button>
        </form>
      )}
      {awaitingReview &&
        (rejecting ? (
          <form
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act("/reject", { storyId: story.storyId, reason });
            }}
          >
            <label htmlFor={`reason-${story.storyId}`}>Reason (shown to the listener)</label>
            <input id={`reason-${story.storyId}`} value={reason} maxLength={280} onChange={(e) => setReason(e.target.value)} />
            <button type="submit" className="button" disabled={working || !reason.trim()}>
              Reject
            </button>
          </form>
        ) : (
          <button type="button" className="button" disabled={working} onClick={() => setRejecting(true)}>
            Reject…
          </button>
        ))}
      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
      {duplicateOf && (
        <button type="button" className="button" disabled={working} onClick={() => void publish(true)}>
          Publish anyway (keep both)
        </button>
      )}
    </article>
  );
}
