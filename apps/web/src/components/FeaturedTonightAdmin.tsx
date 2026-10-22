import { useCallback, useEffect, useState, type FormEvent } from "react";
import { device } from "../lib/device.ts";
import { fetchLibrary } from "../lib/library-data.ts";
import { session } from "../lib/session.ts";
import {
  entryStatus,
  loadSchedule,
  removeSelection,
  saveSelection,
  selectionProblems,
  STATUS_LABEL,
  utcInputFromIso,
  utcIsoFromLocalInput,
  type FeaturedEntry,
  type Schedule,
} from "../lib/featured-admin.ts";
import { StoryListSkeleton } from "./StoryListSkeleton.tsx";

interface PublishedStory {
  storyId: string;
  title: string;
}

/** The fetch the admin calls use: the signed-in admin's session, which the server checks for the ADMIN role. */
const sessionFetch = (path: string, init?: RequestInit) => session.fetch(path, init);

/**
 * The stories that may be featured: the Haunt Originals and the community library, the same stories Home shows. Each
 * source is the public one Home already reads. The server checks publication again on every save.
 */
async function loadPublishedStories(): Promise<PublishedStory[]> {
  const originals = fetch("/api/originals", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<{ originals?: { storyId: string; title: string }[] }>) : Promise.reject(new Error(String(r.status)))))
    .then((d) => (d.originals ?? []).map((o) => ({ storyId: o.storyId, title: o.title })));
  const community = device
    .connect()
    .then((connection) => fetchLibrary(connection.client))
    .then((cards) => cards.map((c) => ({ storyId: c.storyId, title: c.title })))
    .catch(() => [] as PublishedStory[]);
  const [o, c] = await Promise.all([originals, community]);
  const seen = new Set<string>();
  return [...o, ...c].filter((s) => (seen.has(s.storyId) ? false : (seen.add(s.storyId), true)));
}

/**
 * Featured Tonight, for admins. Chooses a published story and a UTC window, lists the schedule with each entry's status,
 * and removes or re-times a selection. Every write goes through /api/admin/featured, which checks the ADMIN role and the
 * schedule version on the server. Only the signed-in admin page mounts this, so it is never shown to listeners.
 */
export function FeaturedTonightAdmin() {
  const [schedule, setSchedule] = useState<Schedule>();
  const [scheduleError, setScheduleError] = useState<string>();
  const [stories, setStories] = useState<PublishedStory[]>();
  const [storyError, setStoryError] = useState<string>();
  const [storyId, setStoryId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const reloadSchedule = useCallback(async () => {
    const result = await loadSchedule(sessionFetch);
    if (result.ok) {
      setSchedule(result.value);
      setScheduleError(undefined);
    } else {
      setSchedule(undefined);
      setScheduleError(result.message);
    }
  }, []);

  useEffect(() => {
    void reloadSchedule();
    loadPublishedStories()
      .then(setStories)
      .catch(() => setStoryError("The published stories couldn't be loaded. Reload the page to try again."));
  }, [reloadSchedule]);

  const publishedIds = new Set((stories ?? []).map((s) => s.storyId));
  const titleOf = (id: string) => stories?.find((s) => s.storyId === id)?.title ?? id;

  const edit = (entry: FeaturedEntry) => {
    setStoryId(entry.storyId);
    setStartsAt(utcInputFromIso(entry.startsAt));
    setEndsAt(utcInputFromIso(entry.endsAt));
    setProblems([]);
    setError(undefined);
    setNotice(undefined);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!schedule) return;
    const start = utcIsoFromLocalInput(startsAt);
    const end = utcIsoFromLocalInput(endsAt);
    const input = { storyId, startsAt: start ?? "", endsAt: end ?? "" };
    const found = selectionProblems(input, Date.now(), publishedIds);
    setProblems(found);
    setError(undefined);
    setNotice(undefined);
    if (found.length) return;
    setSaving(true);
    const result = await saveSelection(sessionFetch, { storyId, startsAt: start!, endsAt: end! }, schedule.version);
    setSaving(false);
    if (result.ok) {
      setSchedule(result.value);
      setNotice(`Saved. ${titleOf(storyId)} is scheduled (schedule version ${result.value.version}).`);
      setStoryId("");
      setStartsAt("");
      setEndsAt("");
    } else {
      setError(result.message);
      if (result.status === 409) await reloadSchedule();
    }
  };

  const remove = async (entry: FeaturedEntry) => {
    if (!schedule) return;
    if (!window.confirm(`Remove ${titleOf(entry.storyId)} from Featured Tonight?`)) return;
    setError(undefined);
    setNotice(undefined);
    const result = await removeSelection(sessionFetch, entry.storyId, schedule.version);
    if (result.ok) {
      setSchedule(result.value);
      setNotice(`Removed ${titleOf(entry.storyId)}.`);
    } else {
      setError(result.message);
      if (result.status === 409) await reloadSchedule();
    }
  };

  const now = Date.now();

  return (
    <section className="card admin-form featured-admin" aria-labelledby="featured-admin-title">
      <h2 id="featured-admin-title">Featured Tonight</h2>
      <p className="muted">Times are UTC. A story is featured from its start time up to, not including, its end time.</p>

      {scheduleError && <p className="error" role="alert">{scheduleError}</p>}
      {!schedule && !scheduleError && <StoryListSkeleton caption="Loading the schedule…" />}

      {schedule && (
        <>
          {schedule.entries.length === 0 ? (
            <p className="muted">Nothing is featured. The public Home shows its normal content.</p>
          ) : (
            <ul className="featured-schedule" aria-label="Current schedule">
              {[...schedule.entries]
                .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
                .map((entry) => {
                  const status = entryStatus(entry, now);
                  const published = publishedIds.has(entry.storyId);
                  return (
                    <li key={entry.storyId} className="featured-entry">
                      <div>
                        <strong>{titleOf(entry.storyId)}</strong>
                        <span className="badge">{STATUS_LABEL[status]}</span>
                        {!published && stories && <span className="error"> Not published: hidden from the public.</span>}
                        <p className="muted">
                          {new Date(entry.startsAt).toISOString().replace("T", " ").slice(0, 16)} to{" "}
                          {new Date(entry.endsAt).toISOString().replace("T", " ").slice(0, 16)} UTC
                        </p>
                      </div>
                      <div className="featured-actions">
                        <button type="button" className="button" onClick={() => edit(entry)} disabled={status === "ended"}>
                          Edit
                        </button>
                        <button type="button" className="button" onClick={() => remove(entry)}>
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                })}
            </ul>
          )}

          <form onSubmit={submit} noValidate>
            <label htmlFor="featured-story">Story</label>
            {storyError && <p className="error">{storyError}</p>}
            <select id="featured-story" value={storyId} onChange={(e) => setStoryId(e.target.value)} disabled={!stories}>
              <option value="">{stories ? "Choose a published story" : "Loading stories…"}</option>
              {(stories ?? []).map((story) => (
                <option key={story.storyId} value={story.storyId}>
                  {story.title}
                </option>
              ))}
            </select>

            <label htmlFor="featured-start">Starts (UTC)</label>
            <input id="featured-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />

            <label htmlFor="featured-end">Ends (UTC)</label>
            <input id="featured-end" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />

            {problems.length > 0 && (
              <ul className="error" role="alert">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            {notice && <p className="muted" role="status">{notice}</p>}

            <button type="submit" className="button primary" disabled={saving || !schedule}>
              {saving ? "Saving…" : "Save selection"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
