import { useEffect, useState, type ReactNode } from "react";
import { homeAuthorLine } from "../lib/author.ts";
import { device } from "../lib/device.ts";
import { fetchFeatured, fetchTrending, knownStories, type Discovery, type FeaturedEntry, type TrendingEntry } from "../lib/discovery.ts";
import { fetchAccountLibrary, type AccountLibrary, type WatchingEntry } from "../lib/engagement.ts";
import { fetchLibrary, type LibraryCard } from "../lib/library-data.ts";
import { session } from "../lib/session.ts";
import { artForStoryId } from "../lib/story-art.ts";
import { navigate } from "../router.tsx";

/** A Haunt Original, as GET /api/originals returns it. Counts are ignored here: they aren't live yet. */
interface Original {
  storyId: string;
  title: string;
  summary: string;
  creator: string;
  genre: string;
  subgenre: string | null;
  minutes: number;
}

/** A listener's own story, as GET /api/me/stories returns it. Progress comes from its real scene counts. */
interface SavedStory {
  storyId: string;
  title: string;
  status: "active" | "completed";
  premise: string;
  scenes: number;
  targetScenes: number;
}

interface HomeData {
  originals: Original[];
  community: LibraryCard[];
  saved: SavedStory[];
  /** The signed-in listener's unfinished published stories, most recently played first. Empty for guests. */
  watching: WatchingEntry[];
  /** The stories the signed-in listener has liked, from their saved likes. Empty for guests. */
  liked: AccountLibrary["likes"];
}

/**
 * The cinematic home: the featured story, Continue Your Nightmare, then the Haunt Originals and the community library.
 * Every value comes from an existing endpoint. A section with nothing real to show is left out, not shown empty.
 */
export function CinematicHome() {
  const [data, setData] = useState<HomeData>();
  // Trending and Featured Tonight load on their own, so a slow or unavailable one never holds up the rest of Home.
  const [trendingState, setTrendingState] = useState<Discovery<TrendingEntry>>({ kind: "loading" });
  const [featuredTonight, setFeaturedTonight] = useState<Discovery<FeaturedEntry>>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    fetchTrending().then((result) => live && setTrendingState(result));
    fetchFeatured().then((result) => live && setFeaturedTonight(result));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    const originals = fetch("/api/originals", { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<{ originals: Original[] }>) : { originals: [] }))
      .then((d) => d.originals ?? [])
      .catch(() => [] as Original[]);
    const community = device
      .connect()
      .then((connection) => fetchLibrary(connection.client))
      .catch(() => [] as LibraryCard[]);
    // Saved stories exist for signed-in listeners and for guests on this device; the server decides which.
    const saved = session
      .fetch("/api/me/stories", { headers: { "X-Haunt-Client": "web" } })
      .then((r) => (r.ok ? (r.json() as Promise<{ stories: SavedStory[] }>) : { stories: [] }))
      .then((d) => d.stories ?? [])
      .catch(() => [] as SavedStory[]);
    // The account's progress, so Continue Watching matches on every device. Guests have none.
    // One request for the account's Continue Watching and Liked Stories.
    const account = fetchAccountLibrary().catch(() => null);
    Promise.all([originals, community, saved, account]).then(([o, c, s, library]) => {
      if (live)
        setData({
          originals: o,
          community: c,
          saved: s.filter((story) => story.status === "active"),
          watching: library?.continueWatching ?? [],
          liked: library?.likes ?? [],
        });
    });
    return () => {
      live = false;
    };
  }, []);

  if (!data) return null;
  const featured = data.originals[0];
  const resumable = data.saved;
  const watching = data.watching;
  const liked = data.liked;
  if (!featured && resumable.length === 0 && watching.length === 0 && liked.length === 0 && data.community.length === 0 && data.originals.length === 0) return null;

  // Titles and summaries come only from the stories Home already loaded. A ranked or featured id with no known story is left out.
  const known = new Map<string, Known>();
  for (const story of data.originals) known.set(story.storyId, story);
  for (const story of data.community) if (!known.has(story.storyId)) known.set(story.storyId, story);
  const openStory = (storyId: string) => navigate(`/alexa?episode=${encodeURIComponent(storyId)}&from=home`);

  return (
    <section className="cine-home" aria-label="Home">
      {featured && <Hero story={featured} />}

      <DiscoveryRail
        title="Featured Tonight"
        state={featuredTonight}
        stories={knownStories(featuredTonight.kind === "ok" ? featuredTonight.items.map((f) => f.storyId) : [], known)}
        badge="Featured Tonight"
        loadingText="Loading tonight's features…"
        errorText="Featured Tonight couldn't be loaded right now."
        onOpen={openStory}
      />

      {liked.length > 0 && (
        <Rail title="Liked Stories">
          {liked.map((story) => (
            <Card
              key={story.storyId}
              title={story.title}
              subtitle={story.summary}
              meta={`${story.minutes} min`}
              art={artForStoryId(story.storyId)}
              badge="Liked"
              onOpen={() => navigate(`/tv?episode=${encodeURIComponent(story.storyId)}`)}
              label={`Open ${story.title}`}
            />
          ))}
        </Rail>
      )}

      {watching.length > 0 && (
        <Rail title="Continue Watching">
          {watching.map((entry) => {
            const progress = entry.totalParts > 0 ? Math.min(1, (entry.partIndex + 1) / entry.totalParts) : 0;
            return (
              <Card
                key={entry.storyId}
                title={entry.title}
                subtitle={entry.summary}
                meta={
                  entry.onMainPath === false
                    ? `Part ${entry.partIndex + 1}`
                    : `Part ${Math.min(entry.partIndex + 1, entry.totalParts)} of ${entry.totalParts}`
                }
                art={artForStoryId(entry.storyId)}
                badge="Continue"
                progress={progress}
                onOpen={() => navigate(`/tv?resume=${encodeURIComponent(entry.storyId)}`)}
                label={`Continue ${entry.title}`}
              />
            );
          })}
        </Rail>
      )}

      {resumable.length > 0 && (
        <Rail title="Continue Your Nightmare">
          {resumable.map((story) => {
            const progress = story.targetScenes > 0 ? Math.min(1, story.scenes / story.targetScenes) : 0;
            return (
              <Card
                key={story.storyId}
                title={story.title}
                subtitle={story.premise}
                meta={`Turn ${story.scenes} of ${story.targetScenes}`}
                art={artForStoryId(story.storyId)}
                badge="In progress"
                progress={progress}
                onOpen={() => navigate(`/alexa?resume=${encodeURIComponent(story.storyId)}`)}
                label={`Resume ${story.title}`}
              />
            );
          })}
        </Rail>
      )}

      {data.originals.length > 0 && (
        <Rail title="Featured Stories">
          {data.originals.map((story) => (
            <Card
              key={story.storyId}
              title={story.title}
              subtitle={story.subgenre ?? story.genre}
              meta={`${story.minutes} min`}
              author={homeAuthorLine(story.creator, false)}
              art={artForStoryId(story.storyId)}
              badge="Haunt Original"
              onOpen={() => navigate(`/alexa?episode=${encodeURIComponent(story.storyId)}&from=home`)}
              label={`Listen to ${story.title}`}
            />
          ))}
        </Rail>
      )}

      <DiscoveryRail
        title="Trending This Week"
        state={trendingState}
        stories={knownStories(trendingState.kind === "ok" ? trendingState.items.map((t) => t.storyId) : [], known)}
        badge="Trending"
        loadingText="Loading what's trending…"
        errorText="Trending couldn't be loaded right now."
        onOpen={openStory}
      />

      {data.community.length > 0 && (
        <Rail title="Community Stories">
          {data.community.map((story) => (
            <Card
              key={story.storyId}
              title={story.title}
              subtitle={story.summary}
              meta={`${story.minutes} min`}
              author={homeAuthorLine(story.creator, false)}
              art={artForStoryId(story.storyId)}
              badge="Community"
              onOpen={() => navigate(`/alexa?episode=${encodeURIComponent(story.storyId)}&from=home`)}
              label={`Listen to ${story.title}`}
            />
          ))}
        </Rail>
      )}
    </section>
  );
}

function Hero({ story }: { story: Original }) {
  const eyebrow = ["Haunt Original", story.genre, story.subgenre].filter(Boolean).join(" · ");
  return (
    <div className="cine-hero" style={{ backgroundImage: `linear-gradient(90deg, rgba(6,7,12,0.96) 0%, rgba(6,7,12,0.7) 45%, rgba(6,7,12,0.25) 100%), linear-gradient(0deg, #07080c 0%, transparent 45%), url(${artForStoryId(story.storyId)})` }}>
      <div className="cine-hero-copy">
        <p className="cine-eyebrow">{eyebrow.toUpperCase()}</p>
        <h2 className="cine-title">{story.title}</h2>
        {story.subgenre && <p className="cine-subtitle">{story.subgenre}</p>}
        <ul className="cine-badges" aria-label="Story details">
          <li>{story.minutes} min</li>
        </ul>
        <p className="cine-description">{story.summary}</p>
        <div className="cine-actions">
          <button
            type="button"
            className="button primary"
            onClick={() => navigate(`/alexa?episode=${encodeURIComponent(story.storyId)}&from=home`)}
          >
            Listen now
          </button>
          <button type="button" className="button" onClick={() => navigate("/library")}>
            More stories
          </button>
        </div>
      </div>
    </div>
  );
}

/** A story Home can show: its title and summary come from the originals or community list Home already loaded. */
type Known = { storyId: string; title: string; summary: string; creator: string; minutes: number };

/**
 * A rail of stories from a live endpoint. Loading and error say so. Unavailable (the feature is off here) and empty are
 * left out, not shown empty, like the other Home rails.
 */
function DiscoveryRail<T>({
  title,
  state,
  stories,
  badge,
  loadingText,
  errorText,
  onOpen,
}: {
  title: string;
  state: Discovery<T>;
  stories: Known[];
  badge: string;
  loadingText: string;
  errorText: string;
  onOpen: (storyId: string) => void;
}) {
  if (state.kind === "unavailable") return null;
  if (state.kind === "loading") return <Rail title={title}><p className="cine-rail-note">{loadingText}</p></Rail>;
  if (state.kind === "error") return <Rail title={title}><p className="cine-rail-note" role="alert">{errorText}</p></Rail>;
  if (stories.length === 0) return null;
  return (
    <Rail title={title}>
      {stories.map((story) => (
        <Card
          key={story.storyId}
          title={story.title}
          subtitle={story.summary}
          meta={`${story.minutes} min`}
          author={homeAuthorLine(story.creator, false)}
          art={artForStoryId(story.storyId)}
          badge={badge}
          onOpen={() => onOpen(story.storyId)}
          label={`Listen to ${story.title}`}
        />
      ))}
    </Rail>
  );
}

function Rail({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cine-rail">
      <h3 className="cine-rail-title">{title}</h3>
      <div className="cine-rail-track">{children}</div>
    </div>
  );
}

function Card(props: {
  title: string;
  subtitle?: string;
  meta?: string;
  /** The author line: "By {name}", or "Haunt Originals" when the story has no creator name. */
  author?: string;
  art: string;
  badge: string;
  progress?: number;
  onOpen: () => void;
  label: string;
}) {
  return (
    <button type="button" className="cine-card" onClick={props.onOpen} aria-label={props.label}>
      <span className="cine-card-art" style={{ backgroundImage: `url(${props.art})` }}>
        <span className="cine-card-badge">{props.badge}</span>
        {props.progress !== undefined && (
          <span className="cine-progress" aria-label={`${Math.round(props.progress * 100)}% through`}>
            <span style={{ width: `${Math.round(props.progress * 100)}%` }} />
          </span>
        )}
      </span>
      <span className="cine-card-title">{props.title}</span>
      {props.author && <span className="cine-card-author">{props.author}</span>}
      {props.subtitle && <span className="cine-card-subtitle">{props.subtitle}</span>}
      {props.meta && <span className="cine-card-meta">{props.meta}</span>}
    </button>
  );
}
