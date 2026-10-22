import { useEffect, useRef, useState } from "react";
import { StoryListSkeleton } from "../components/StoryListSkeleton.tsx";
import { navigate } from "../router.tsx";
import { device } from "../lib/device.ts";
import { publishNotice } from "../lib/admin-publish.ts";
import { fetchLibrary, type LibraryCard } from "../lib/library-data.ts";
import { fetchTotals, TOTALS_POLL_MS, usePoll } from "../lib/engagement.ts";

type EpisodeSummary = LibraryCard;

export function Library() {
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>();
  const [error, setError] = useState<string>();

  // Set when the admin page sends us here after publishing; read once, then the address is tidied.
  const [notice] = useState(() => publishNotice(window.location.search));
  useEffect(() => {
    if (notice) window.history.replaceState(null, "", "/library");
    // A fresh call every time the page opens, so a story published a moment ago is listed.
    device
      .connect()
      .then((connection) => fetchLibrary(connection.client))
      .then(setEpisodes)
      .catch((e: Error) => setError(e.message));
  }, [notice]);
  // Play and like totals refresh while the page is open; the list itself is fetched once per visit.
  const episodesRef = useRef<EpisodeSummary[] | undefined>(undefined);
  episodesRef.current = episodes;
  usePoll(
    () => {
      const ids = episodesRef.current?.map((e) => e.storyId) ?? [];
      fetchTotals(ids)
        .then((totals) => setEpisodes((list) => list && list.map((e) => (totals[e.storyId] ? { ...e, ...totals[e.storyId] } : e))))
        .catch(() => {});
    },
    TOTALS_POLL_MS,
  );

  return (
    <div className="page">
      <header className="page-head">
        <span className="eyebrow">Library</span>
        <h1>Stories other listeners shaped</h1>
        <p className="lede">Finished stories, narrated straight through: no questions, no interruptions.</p>
      </header>
      {notice && (
        <p className="publish-notice" role="status">
          ✓ {notice.message}{" "}
          {episodes && !episodes.some((e) => e.storyId === notice.storyId) && "It may take a moment to appear; refresh if it isn't listed."}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!episodes && !error && <StoryListSkeleton caption="Gathering the library…" />}
      {episodes?.length === 0 && (
        <div className="card empty-state">
          <p>The library is empty for now. The first episodes are being recorded.</p>
          <button type="button" className="button" onClick={() => navigate("/alexa")}>
            Make your own story
          </button>
        </div>
      )}
      <div className="episode-grid">
        {/* Same list as /tv: one card per source story id, newest first (lib/library-data.ts). */}
        {episodes?.map((episode) => (
          <article
            key={episode.storyId}
            className={`card episode${notice?.storyId === episode.storyId ? " is-new" : ""}`}
            aria-current={notice?.storyId === episode.storyId ? "true" : undefined}
          >
            <h2>{episode.title}</h2>
            <p>{episode.summary}</p>
            <p className="muted">
              {episode.minutes} min{episode.parts ? ` · ${episode.parts} parts` : ""} · by {episode.creator}
              {episode.publishedAt ? ` · ${new Date(episode.publishedAt).toLocaleDateString()}` : ""}
            </p>
            {episode.plays != null && (
              <p className="story-totals">
                ▶ {episode.plays.toLocaleString()} {episode.plays === 1 ? "play" : "plays"}
                {episode.likes != null ? ` · ♥ ${episode.likes.toLocaleString()}` : ""}
              </p>
            )}
            <button
              type="button"
              className="button"
              onClick={() => navigate(`/tv?episode=${encodeURIComponent(episode.storyId)}`)}
            >
              Listen
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
