import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_FORM,
  describeFields,
  FEAR,
  LANGUAGES,
  LENGTHS,
  parseCreateCommand,
  premiseFor,
  SUBGENRES,
  type CreateForm,
} from "../lib/create-voice.ts";
import type { StartStoryInput } from "../lib/device.ts";
import { parseNavigation, pickStory } from "../lib/device-voice.ts";
import { useMyStories, type SavedStory } from "../lib/my-stories.ts";
import type { HauntConnection } from "../lib/mcp.ts";
import { artForStoryId } from "../lib/story-art.ts";

/**
 * The Haunt app on the simulated Echo Show screen: Home, Community, My Stories and Create tabs, plus a profile panel,
 * in the Fire TV app's look. Everything a listener does here goes through the same paths as speaking: stories are listed
 * with the MCP list_library tool, played with play_episode, and Create calls start_story with exactly what was chosen,
 * by tapping or by voice (lib/create-voice.ts).
 */

type Tab = "home" | "community" | "mine" | "create" | "profile";

interface CommunityStory {
  storyId: string;
  title: string;
  summary?: string;
  creator?: string;
  minutes?: number;
}

// Each one works spoken or tapped: create, browse, continue, and a quick story from the assistant.
const EXAMPLES = [
  "Create a terrifying cosmic horror story in Hindi about a lighthouse",
  "Open community",
  "Continue my last story",
  "Tell me a scary story about the last train from an empty station",
];

/** Community stories over MCP (list_library), so the call shows in the inspector. Empty on failure. */
function useCommunityStories(connection: HauntConnection | undefined): CommunityStory[] | null {
  const [stories, setStories] = useState<CommunityStory[] | null>(null);
  useEffect(() => {
    if (!connection) return;
    let live = true;
    connection
      .call("list_library", {})
      .result.then((result) => {
        const data = result.structuredContent as { episodes?: CommunityStory[] } | undefined;
        if (live) setStories(result.isError ? [] : (data?.episodes ?? []));
      })
      .catch(() => live && setStories([]));
    return () => {
      live = false;
    };
  }, [connection]);
  return stories;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function DeviceApp({
  connection,
  onSay,
  onPlay,
  onStart,
  onVoice,
  onResume,
}: {
  connection: HauntConnection | undefined;
  /** Says something to the assistant on the listener's behalf. */
  onSay: (text: string) => void;
  onPlay: (storyId: string) => void;
  /** Starts a story with the Create form's choices (MCP start_story). */
  onStart: (input: StartStoryInput) => void;
  /** Registers what to do with heard speech before the assistant gets it. Returns an unregister function. */
  onVoice?: (router: (text: string) => boolean) => () => void;
  /** Continues one of the listener's stories (MCP resume_story). */
  onResume: (storyId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const [form, setForm] = useState<CreateForm>(DEFAULT_FORM);
  /** The last thing heard on the Create screen and what it changed, shown under the form. */
  const [heard, setHeard] = useState<{ text: string; changes: string[] } | null>(null);
  const community = useCommunityStories(connection);
  const mine = useMyStories();
  const clock = useClock();
  /** A short line at the bottom of the screen after a voice command that couldn't be done ("No story called …"). */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const start = (next: CreateForm) => onStart({ premise: premiseFor(next), subgenre: next.subgenre, length: next.length, intensity: next.intensity, language: next.language });

  // Voice: on the Create screen everything said edits the form ("make it terrifying", "in Hindi", "generate").
  // Anywhere else, "create a story …" opens Create with what was said filled in; other speech goes to the assistant.
  const state = useRef({ tab, form, community, mine });
  state.current = { tab, form, community, mine };
  useEffect(() => {
    if (!onVoice) return;
    return onVoice((text) => {
      const { tab: current, form: currentForm, community: shared, mine: own } = state.current;

      // Navigation: "open community", "play the first one", "continue my lighthouse story".
      const nav = parseNavigation(text);
      if (nav?.kind === "tab") {
        setTab(nav.tab);
        return true;
      }
      if (nav?.kind === "play") {
        // On My Stories, "play" means continue one of yours; elsewhere it plays a community story.
        if (current === "mine") {
          const story = pickStory(own, nav.pick);
          if (story) onResume(story.storyId);
          else setNotice(own.length ? "Couldn’t find that one in My Stories." : "No stories yet. Say “create a story” to make one.");
          return true;
        }
        const story = pickStory(shared ?? [], nav.pick);
        if (story) onPlay(story.storyId);
        else setNotice(shared?.length ? "Couldn’t find that story in Community." : "No community stories to play yet.");
        return true;
      }
      if (nav?.kind === "continue") {
        // "my last story" is the most recent one, which My Stories lists first.
        const pick = "index" in nav.pick && nav.pick.index === -1 ? { index: 0 } : nav.pick;
        const story = pickStory(own, pick);
        if (story) onResume(story.storyId);
        else {
          setTab("mine");
          setNotice(own.length ? "Couldn’t find that one in My Stories." : "No stories yet. Say “create a story” to make one.");
        }
        return true;
      }

      const command = parseCreateCommand(text);
      const changes = describeFields(command.fields);
      const onCreate = current === "create";
      if (!onCreate && command.action !== "open" && !(command.action === "generate" && changes.length)) return false;
      const next = { ...currentForm, ...command.fields };
      setForm(next);
      setTab("create");
      setHeard({ text, changes });
      if (command.action === "generate") start(next);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onVoice]);

  return (
    <div className="da">
      <header className="da-top">
        <button type="button" className="da-logo" onClick={() => setTab("home")} aria-label="Haunt home">
          <span className="tv-wordmark">
            HAUNT
            <span className="tv-wordmark-bar" aria-hidden />
          </span>
        </button>
        <nav className="da-tabs" aria-label="Haunt">
          {(
            [
              ["home", "Home"],
              ["community", "Community"],
              ["mine", "My Stories"],
              ["create", "Create"],
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" className={`da-tab${tab === id ? " is-on" : ""}`} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="da-clock">{clock}</span>
        <button type="button" className={`da-profile${tab === "profile" ? " is-on" : ""}`} onClick={() => setTab("profile")} aria-label="Profile">
          <span className="da-avatar">G</span>
          <span>Guest</span>
        </button>
      </header>

      <div className="da-body" key={tab}>
        {tab === "home" && <HomeTab community={community} onSay={onSay} onPlay={onPlay} onBrowse={() => setTab("community")} />}
        {tab === "community" && <CommunityTab community={community} onPlay={onPlay} />}
        {tab === "mine" && <MyStoriesTab stories={mine} onResume={onResume} />}
        {tab === "create" && <CreateTab form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} heard={heard} onGenerate={() => start(form)} />}
        {tab === "profile" && <ProfileTab onCreate={() => setTab("create")} />}
      </div>
      {notice && (
        <div className="da-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

function StoryCard({ story, onPlay }: { story: CommunityStory; onPlay: (storyId: string) => void }) {
  return (
    <button type="button" className="da-card" onClick={() => onPlay(story.storyId)}>
      <span className="da-card-art" style={{ backgroundImage: `url(${artForStoryId(story.storyId)})` }}>
        <span className="da-badge">Community</span>
      </span>
      <span className="da-card-title">{story.title}</span>
      <span className="da-card-meta">
        {story.minutes ? `${story.minutes} min` : "Listen"}
        {story.creator ? ` · by ${story.creator}` : ""}
      </span>
    </button>
  );
}

function HomeTab({
  community,
  onSay,
  onPlay,
  onBrowse,
}: {
  community: CommunityStory[] | null;
  onSay: (text: string) => void;
  onPlay: (storyId: string) => void;
  onBrowse: () => void;
}) {
  const featured = community?.[0];
  return (
    <>
      <img className="da-art" src={featured ? artForStoryId(featured.storyId) : "/art/ashford-house.svg"} alt="" />
      <div className="da-shade" aria-hidden />
      <section className="da-hero">
        {featured ? (
          <>
            <span className="eyebrow">Community · Tonight</span>
            <h2 className="da-hero-title">{featured.title}</h2>
            {featured.summary && <p className="da-hero-text">{featured.summary}</p>}
            <div className="da-actions">
              <button type="button" className="da-button primary" onClick={() => onPlay(featured.storyId)}>
                ▶ Listen
              </button>
              <button type="button" className="da-button" onClick={onBrowse}>
                Browse community
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="eyebrow">Horror · Interactive</span>
            <h2 className="da-hero-title">Every choice echoes in the dark.</h2>
            <p className="da-hero-text">Ask for a story out loud. Haunt stops at the worst moment and asks what you do next.</p>
          </>
        )}
      </section>
      <section className="da-rail">
        <span className="eyebrow">Try saying</span>
        <div className="da-chips">
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="da-chip" onClick={() => onSay(example)}>
              “{example}”
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function CommunityTab({ community, onPlay }: { community: CommunityStory[] | null; onPlay: (storyId: string) => void }) {
  return (
    <section className="da-page">
      <h2 className="da-page-title">Community</h2>
      <p className="da-page-text">Finished stories other listeners shared, told straight through.</p>
      {community === null ? (
        <div className="da-grid">
          {[0, 1, 2].map((i) => (
            <span key={i} className="da-card da-skeleton" />
          ))}
        </div>
      ) : community.length ? (
        <div className="da-grid">
          {community.map((story) => (
            <StoryCard key={story.storyId} story={story} onPlay={onPlay} />
          ))}
        </div>
      ) : (
        <div className="da-empty">
          <strong>No community stories yet</strong>
          <span>Shared stories appear here once they’re approved.</span>
        </div>
      )}
    </section>
  );
}

function MyStoriesTab({ stories, onResume }: { stories: SavedStory[]; onResume: (storyId: string) => void }) {
  return (
    <section className="da-page">
      <div className="da-page-head">
        <div>
          <h2 className="da-page-title">My Stories</h2>
          <p className="da-page-text">Stories you started on this device. Pick one, or say “continue” and its name.</p>
        </div>
      </div>
      {stories.length ? (
        <div className="da-grid">
          {stories.map((story) => (
            <button key={story.storyId} type="button" className="da-card" onClick={() => onResume(story.storyId)}>
              <span className="da-card-art" style={{ backgroundImage: `url(${artForStoryId(story.storyId)})` }}>
                <span className="da-badge">{story.status === "completed" ? "Finished" : "In progress"}</span>
                {story.status === "active" && (
                  <span className="da-progress">
                    <span style={{ width: `${Math.min(100, Math.round((story.sceneNumber / Math.max(1, story.totalScenes)) * 100))}%` }} />
                  </span>
                )}
              </span>
              <span className="da-card-title">{story.title}</span>
              <span className="da-card-meta">
                {story.status === "completed" ? "Finished · play it again" : `Turn ${story.sceneNumber} of ${story.totalScenes}`} · {when(story.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="da-empty">
          <strong>No stories yet</strong>
          <span>Create a story from the Create tab, or say “create a story”, and it will appear here.</span>
        </div>
      )}
    </section>
  );
}

/** "Just now", "12 min ago", "3 h ago", or the date. */
function when(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(time).toLocaleDateString();
}

function CreateTab({
  form,
  onChange,
  heard,
  onGenerate,
}: {
  form: CreateForm;
  onChange: (patch: Partial<CreateForm>) => void;
  heard: { text: string; changes: string[] } | null;
  onGenerate: () => void;
}) {
  const chosen = SUBGENRES.find((s) => s.id === form.subgenre)!;

  return (
    <section className="da-page da-create">
      <div className="da-create-main">
        <span className="eyebrow">Create your own story</span>
        <h2 className="da-page-title">Design your nightmare</h2>

        <span className="da-label">Sub-genre</span>
        <div className="da-subgenres" role="radiogroup" aria-label="Sub-genre">
          {SUBGENRES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={form.subgenre === s.id}
              className={`da-subgenre${form.subgenre === s.id ? " is-on" : ""}`}
              style={{ backgroundImage: `url(${s.art})` }}
              onClick={() => onChange({ subgenre: s.id })}
            >
              <span>{s.name}</span>
            </button>
          ))}
        </div>

        <label className="da-label" htmlFor="da-idea">
          Your idea (optional)
        </label>
        <input
          id="da-idea"
          className="da-input"
          value={form.idea}
          onChange={(e) => onChange({ idea: e.target.value })}
          placeholder="e.g. a ghost who rides the last train home"
          maxLength={500}
        />

        <span className="da-label">Length</span>
        <div className="da-lengths" role="radiogroup" aria-label="Length">
          {LENGTHS.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={form.length === l.id} className={`da-length${form.length === l.id ? " is-on" : ""}`} onClick={() => onChange({ length: l.id })}>
              <strong>{l.name}</strong>
              <span>{l.detail}</span>
            </button>
          ))}
        </div>

        <span className="da-label">Fear level</span>
        <div className="da-lengths" role="radiogroup" aria-label="Fear level">
          {(["eerie", "scary", "terrifying"] as const).map((id) => {
            const f = FEAR.find((x) => x.id === id)!;
            return (
              <button key={f.id} type="button" role="radio" aria-checked={form.intensity === f.id} className={`da-length${form.intensity === f.id ? " is-on" : ""}`} onClick={() => onChange({ intensity: f.id })}>
                <strong>{f.name}</strong>
                <span>{f.detail}</span>
              </button>
            );
          })}
        </div>

        <span className="da-label">Language</span>
        <div className="da-languages" role="radiogroup" aria-label="Language">
          {LANGUAGES.map((l) => (
            <button key={l.code} type="button" role="radio" aria-checked={form.language === l.code} className={`da-lang${form.language === l.code ? " is-on" : ""}`} onClick={() => onChange({ language: l.code })}>
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <aside className="da-summary">
        <span className="eyebrow">Your story</span>
        <strong className="da-summary-title">{chosen.name}</strong>
        <span className="da-summary-text">{form.idea.trim() || "Built from your sub-genre"}</span>
        <dl className="da-summary-list">
          <dt>Length</dt>
          <dd>{LENGTHS.find((l) => l.id === form.length)!.name}</dd>
          <dt>Fear</dt>
          <dd>{FEAR.find((f) => f.id === form.intensity)!.name}</dd>
          <dt>Language</dt>
          <dd>{LANGUAGES.find((l) => l.code === form.language)!.label.split(" · ").pop()}</dd>
        </dl>
        <button type="button" className="da-button primary wide" onClick={onGenerate}>
          Generate My Story
        </button>

        {heard ? (
          <div className="da-heard" aria-live="polite">
            <span className="da-heard-label">🎙 Heard</span>
            <span className="da-heard-text">“{heard.text}”</span>
            <span className={`da-heard-result${heard.changes.length ? "" : " is-miss"}`}>
              {heard.changes.length ? `Set: ${heard.changes.join(" · ")}` : 'Nothing to change. Try “cosmic horror”, “make it short”, “in Hindi” or “generate”.'}
            </span>
          </div>
        ) : (
          <div className="da-voice-tips">
            <span className="da-heard-label">Say it instead</span>
            <span>“Cosmic horror”</span>
            <span>“About a lighthouse that lights itself”</span>
            <span>“Make it short” · “Terrifying”</span>
            <span>“In Hindi”</span>
            <span>“Generate”</span>
          </div>
        )}
      </aside>
    </section>
  );
}

function ProfileTab({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="da-page da-profile-page">
      <div className="da-profile-card">
        <span className="da-avatar large">G</span>
        <div>
          <h2 className="da-page-title">Guest</h2>
          <p className="da-page-text">Listening on this Echo Show. No account needed to play.</p>
        </div>
      </div>
      <div className="da-stats">
        <div>
          <strong>Voice</strong>
          <span>Say “one”, “two” or your own answer</span>
        </div>
        <div>
          <strong>Narration</strong>
          <span>Read aloud, word for word</span>
        </div>
        <div>
          <strong>Screen</strong>
          <span>Scenes and choices appear here</span>
        </div>
      </div>
      <button type="button" className="da-button primary" onClick={onCreate}>
        + Create a story
      </button>
    </section>
  );
}
