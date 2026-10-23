import { useEffect, useRef, useState, type FormEvent } from "react";
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
import { parseAccount, parseNavigation, pickStory } from "../lib/device-voice.ts";
import { fetchMyStories, fromListed, useMyStories, type ListedStory, type SavedStory } from "../lib/my-stories.ts";
import { hasTool, type HauntConnection } from "../lib/mcp.ts";
import { session, useSession, type SessionState } from "../lib/session.ts";
import { useQrSignIn } from "../lib/qr-sign-in.ts";
import { artForStoryId } from "../lib/story-art.ts";

/**
 * The Haunt app on the simulated Echo Show screen: Home, Community, My Stories and Create tabs, plus a profile panel,
 * in the Fire TV app's look. Everything a listener does here goes through the same paths as speaking: Home comes from the
 * MCP get_home tool, Community from list_library and My Stories from list_my_stories. Stories are played with play_episode
 * or continued with resume_story, and Create calls start_story with exactly what was chosen, by tapping or by voice
 * (lib/create-voice.ts).
 */

type Tab = "home" | "community" | "mine" | "create" | "profile" | "signin";

/** Cognito's sign-in code has eight digits; an account-confirmation code is six to eight (null). */
const SIGN_IN_CODE_DIGITS = 8;

/** Community stories and creating need an account: a guest sees a sign-in card instead. My Stories stays open. */
const isLocked = (account: SessionState) => account.status !== "signed-in";
type Gated = "community" | "create";

/** "tejaswi@mobil80.com" → "T"; a guest is "G". */
const initial = (account: SessionState) => (account.user?.email?.[0] ?? "G").toUpperCase();

export interface CommunityStory {
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

/**
 * The listener's stories over MCP (list_my_stories), asked for again whenever `openedOn` changes to a tab (null: not shown)
 * and after signing in or out. Until the server answers, or when it can't (a server without the tool), the stories
 * remembered in this browser.
 */
function useListedStories(connection: HauntConnection | undefined, openedOn: Tab | null, who: string): SavedStory[] {
  const remembered = useMyStories();
  const [listed, setListed] = useState<{ who: string; stories: SavedStory[] } | null>(null);
  useEffect(() => {
    if (!connection || !openedOn) return;
    let live = true;
    void fetchMyStories(connection).then((stories) => live && stories && setListed({ who, stories }));
    return () => {
      live = false;
    };
  }, [connection, openedOn, who]);
  // Never show the previous account's list after signing in or out.
  return listed?.who === who ? listed.stories : remembered;
}

interface HomeData {
  tonight: CommunityStory | null;
  continueStory: SavedStory | null;
}

/**
 * Home over MCP (get_home): tonight's story and the listener's unfinished one. null until it answers, or if it can't,
 * including on a server that doesn't list get_home yet (Home then uses list_library).
 */
function useHome(connection: HauntConnection | undefined, open: boolean, who: string): HomeData | null {
  const [home, setHome] = useState<HomeData | null>(null);
  useEffect(() => {
    // call() throws for a tool the server doesn't list, so ask only a server that has it.
    if (!connection || !open || !hasTool(connection, "get_home")) return;
    let live = true;
    Promise.resolve()
      .then(() => connection.call("get_home", {}).result)
      .then((result) => {
        const data = result.structuredContent as { tonight?: CommunityStory | null; continueStory?: ListedStory | null } | undefined;
        if (!live) return;
        setHome(result.isError || !data ? null : { tonight: data.tonight ?? null, continueStory: data.continueStory ? fromListed(data.continueStory) : null });
      })
      .catch(() => live && setHome(null));
    return () => {
      live = false;
    };
  }, [connection, open, who]);
  return home;
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
  onPlay: (story: CommunityStory) => void;
  /** Starts a story with the Create form's choices (MCP start_story). */
  onStart: (input: StartStoryInput) => void;
  /** Registers what to do with heard speech before the assistant gets it. Returns an unregister function. */
  onVoice?: (router: (text: string) => boolean) => () => void;
  /** Continues one of the listener's stories (MCP resume_story). */
  onResume: (story: SavedStory) => void;
}) {
  const [tab, setTab] = useState<Tab>("home");
  const [form, setForm] = useState<CreateForm>(DEFAULT_FORM);
  /** The last thing heard on the Create screen and what it changed, shown under the form. */
  const [heard, setHeard] = useState<{ text: string; changes: string[] } | null>(null);
  const community = useCommunityStories(connection);
  const clock = useClock();
  const account = useSession();
  const who = `${account.status}:${account.user?.email ?? ""}`;
  const mine = useListedStories(connection, tab === "mine" || tab === "home" ? tab : null, who);
  const home = useHome(connection, tab === "home", who);
  /** A short line at the bottom of the screen after a voice command that couldn't be done ("No story called …"). */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Where to come back to after signing in: the locked tab that asked for it, or Profile. */
  const [returnTo, setReturnTo] = useState<Gated | "profile">("profile");
  const askSignIn = (next: Gated | "profile" = "profile") => {
    setReturnTo(next);
    setTab("signin");
  };
  const signIn = () => askSignIn("profile");

  /** Plays a community story, or asks a guest to sign in first. */
  const playCommunity = (story: CommunityStory) => {
    if (isLocked(state.current.account)) return askSignIn("community");
    onPlay(story);
  };

  const start = (next: CreateForm) => {
    if (isLocked(state.current.account)) return askSignIn("create");
    onStart({ premise: premiseFor(next), subgenre: next.subgenre, length: next.length, intensity: next.intensity, language: next.language });
  };

  // Voice: on the Create screen everything said edits the form ("make it terrifying", "in Hindi", "generate").
  // Anywhere else, "create a story …" opens Create with what was said filled in; other speech goes to the assistant.
  /** The sign-in screen's code box, filled by voice. */
  const spokenCode = useRef<((code: string) => void) | null>(null);
  const state = useRef({ tab, form, community, mine, account });
  state.current = { tab, form, community, mine, account };
  useEffect(() => {
    if (!onVoice) return;
    return onVoice((text) => {
      const { tab: current, form: currentForm, community: shared, mine: own } = state.current;

      // On the sign-in screen, a spoken code ("my code is 1 2 3 4 5 6 7 8") goes into the code box.
      // Any digits said there (even part of the code) go into the box, never to the assistant.
      if (current === "signin") {
        const digits = text.replace(/\D/g, "");
        if (digits.length > 0 && digits.length <= 8 && spokenCode.current) {
          spokenCode.current(digits);
          return true;
        }
        if (/^(?:my )?(?:sign[- ]?in )?code\b/i.test(text.trim())) return true;
      }

      // "Sign in" / "sign out".
      const accountCommand = parseAccount(text);
      if (accountCommand) {
        const now = state.current.account;
        if (!now.available) setNotice("Sign-in isn’t set up on this server. Everything works as a guest.");
        else if (accountCommand === "in") now.status === "signed-in" ? setNotice(`Already signed in as ${now.user?.email ?? "you"}.`) : signIn();
        else if (now.status === "signed-in") {
          void session.signOut();
          setNotice("Signed out. You’re a guest now.");
        }
        return true;
      }

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
          if (story) onResume(story);
          else setNotice(own.length ? "Couldn’t find that one in My Stories." : "No stories yet. Say “create a story” to make one.");
          return true;
        }
        const story = pickStory(shared ?? [], nav.pick);
        if (story) playCommunity(story);
        else setNotice(shared?.length ? "Couldn’t find that story in Community." : "No community stories to play yet.");
        return true;
      }
      if (nav?.kind === "continue") {
        // "my last story" is the most recent one, which My Stories lists first.
        const pick = "index" in nav.pick && nav.pick.index === -1 ? { index: 0 } : nav.pick;
        const story = pickStory(own, pick);
        if (story) onResume(story);
        else {
          setTab("mine");
          setNotice(own.length ? "Couldn’t find that one in My Stories." : "No stories yet. Say “create a story” to make one.");
        }
        return true;
      }

      const command = parseCreateCommand(text);
      const changes = describeFields(command.fields);
      const onCreate = current === "create";
      if (!onCreate && command.action !== "open" && !(command.action === "generate" && changes.length)) {
        // A guest asking the assistant for a story ("tell me a scary story…") would create one: that needs an account too.
        if (isLocked(state.current.account) && /\b(?:story|stories|tale)\b/i.test(text)) {
          setTab("create");
          return true;
        }
        return false;
      }
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
        <button
          type="button"
          className={`da-profile${tab === "profile" || tab === "signin" ? " is-on" : ""}`}
          onClick={() => setTab("profile")}
          aria-label={account.status === "signed-in" ? `Profile, signed in as ${account.user?.email ?? "you"}` : "Profile, guest"}
        >
          <span className="da-avatar">{initial(account)}</span>
        </button>
      </header>

      <div className="da-body" key={tab}>
        {tab === "home" && (
          <HomeTab
            featured={(home ? home.tonight : community?.[0]) ?? undefined}
            continueStory={home?.continueStory ?? null}
            onSay={onSay}
            onPlay={playCommunity}
            onResume={onResume}
            onBrowse={() => setTab("community")}
          />
        )}
        {tab === "community" &&
          (isLocked(account) ? <SignInWall kind="community" account={account} onSignIn={() => askSignIn("community")} onBack={() => setTab("home")} /> : <CommunityTab community={community} onPlay={playCommunity} />)}
        {tab === "mine" && <MyStoriesTab stories={mine} onResume={onResume} />}
        {tab === "create" &&
          (isLocked(account) ? (
            <SignInWall kind="create" account={account} onSignIn={() => askSignIn("create")} onBack={() => setTab("home")} />
          ) : (
            <CreateTab form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} heard={heard} onGenerate={() => start(form)} needsSignIn={false} />
          ))}
        {tab === "profile" && <ProfileTab account={account} onSignIn={signIn} />}
        {tab === "signin" && (
          <SignInTab account={account} purpose={returnTo === "profile" ? undefined : returnTo} onDone={() => setTab(returnTo)} onCode={(fill) => (spokenCode.current = fill)} />
        )}
      </div>
      {notice && (
        <div className="da-notice" role="status">
          {notice}
        </div>
      )}
    </div>
  );
}

function StoryCard({ story, onPlay }: { story: CommunityStory; onPlay: (story: CommunityStory) => void }) {
  return (
    <button type="button" className="da-card" onClick={() => onPlay(story)}>
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
  featured,
  continueStory,
  onSay,
  onPlay,
  onResume,
  onBrowse,
}: {
  /** Tonight's community story (get_home), or the newest one (list_library) on a server without get_home. */
  featured: CommunityStory | undefined;
  /** The listener's most recent unfinished story, from get_home. */
  continueStory: SavedStory | null;
  onSay: (text: string) => void;
  onPlay: (story: CommunityStory) => void;
  onResume: (story: SavedStory) => void;
  onBrowse: () => void;
}) {
  const resume = continueStory && (
    <button type="button" className="da-button" onClick={() => onResume(continueStory)} title={`Continue “${continueStory.title}”`}>
      Continue
    </button>
  );
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
              <button type="button" className="da-button primary" onClick={() => onPlay(featured)}>
                ▶ Listen
              </button>
              {resume}
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
            {resume && <div className="da-actions">{resume}</div>}
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

function CommunityTab({ community, onPlay }: { community: CommunityStory[] | null; onPlay: (story: CommunityStory) => void }) {
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

function MyStoriesTab({ stories, onResume }: { stories: SavedStory[]; onResume: (story: SavedStory) => void }) {
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
            <button key={story.storyId} type="button" className="da-card" onClick={() => onResume(story)}>
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
  needsSignIn,
}: {
  form: CreateForm;
  onChange: (patch: Partial<CreateForm>) => void;
  heard: { text: string; changes: string[] } | null;
  onGenerate: () => void;
  /** A guest where sign-in exists: Generate asks them to sign in first. */
  needsSignIn: boolean;
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
          {needsSignIn ? "Sign in to Generate" : "Generate My Story"}
        </button>
        {needsSignIn && <p className="da-signin-note">Creating a story needs an account. After signing in you come straight back here.</p>}

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

function ProfileTab({ account, onSignIn }: { account: SessionState; onSignIn: () => void }) {
  const signedIn = account.status === "signed-in";
  return (
    <section className="da-page da-profile-page">
      <div className={`da-profile-hero${signedIn ? " is-signed-in" : ""}`}>
        <span className="da-avatar huge" aria-hidden>
          {initial(account)}
        </span>
        <span className="da-profile-status">{account.status === "loading" ? "Checking…" : signedIn ? "Signed in" : "Guest"}</span>
        <h2 className="da-profile-title">{signedIn ? (account.user?.email ?? "Your account") : "Welcome to Haunt"}</h2>
        <p className="da-profile-text">
          {signedIn
            ? "You can create your own stories now."
            : account.available
              ? "Sign in to create your own stories."
              : "Sign-in isn’t set up here. Everything works as a guest."}
        </p>
        {account.available && account.status !== "loading" && (
          signedIn ? (
            <button type="button" className="da-button" onClick={() => void session.signOut()}>
              Sign out
            </button>
          ) : (
            <button type="button" className="da-button primary" onClick={onSignIn}>
              Sign in
            </button>
          )
        )}
      </div>
    </section>
  );
}

const LOCKED_COPY: Record<Gated, { eyebrow: string; title: string; text: string }> = {
  community: {
    eyebrow: "Community",
    title: "Sign in to listen to Community",
    text: "Finished stories other listeners shared live here. Sign in to browse them and play one.",
  },
  create: {
    eyebrow: "Create",
    title: "Sign in to create a story",
    text: "A story you make is saved to your account, so you can leave and pick it up later.",
  },
};

/** Shown instead of Community or Create to a guest. */
function SignInWall({ kind, account, onSignIn, onBack }: { kind: Gated; account: SessionState; onSignIn: () => void; onBack: () => void }) {
  const copy = LOCKED_COPY[kind];
  return (
    <section className="da-page da-signin-page">
      <div className="si-card si-locked">
        <span className="si-lock" aria-hidden>
          <LockIcon />
        </span>
        <span className="si-eyebrow">{copy.eyebrow}</span>
        <h2 className="si-title">{copy.title}</h2>
        <p className="si-sub">
          {account.status === "loading"
            ? "Checking your account…"
            : account.available
              ? copy.text
              : "Sign-in isn’t set up on this server yet, so this stays locked until an account can be used."}
        </p>
        <div className="si-locked-actions">
          {account.available && account.status !== "loading" && (
            <button type="button" className="si-primary" onClick={onSignIn}>
              Sign in
            </button>
          )}
          <button type="button" className="da-link" onClick={onBack}>
            Back to Home
          </button>
        </div>
        <p className="si-hint">Or say “sign in”</p>
      </div>
    </section>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="5" y="10.5" width="14" height="10" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Sign-in on the Echo Show screen, two ways side by side: scan a QR code with a phone (lib/qr-sign-in.ts, the same
 * pairing as the website), or get a code by email (lib/session.ts, the same Cognito flow). The emailed code can be typed
 * or spoken ("my code is 1 2 3 4…"). Signing in either way returns to Profile.
 */
function SignInTab({
  account,
  purpose,
  onDone,
  onCode,
}: {
  account: SessionState;
  /** Set when a locked tab sent the listener here; the heading says what signing in unlocks. */
  purpose?: Gated;
  onDone: () => void;
  /** Hands the parent a way to fill the code box by voice. */
  onCode: (fill: ((code: string) => void) | null) => void;
}) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeLength, setCodeLength] = useState<number | null>(SIGN_IN_CODE_DIGITS);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const codeInput = useRef<HTMLInputElement>(null);

  // The phone QR shows while the email side is on its first step; a phone's approval signs this device in.
  const qr = useQrSignIn(account.available && account.status !== "signed-in" && step === "email", () => void session.init());

  useEffect(() => {
    if (account.status === "signed-in") onDone();
  }, [account.status, onDone]);
  useEffect(() => {
    // A whole code replaces what's there; a few digits at a time add to it ("5 7 6 1", then "8 7 7 3").
    onCode(step === "code" ? (spoken) => setCode((current) => (spoken.length >= 6 ? spoken : (current + spoken)).slice(0, 8)) : null);
    return () => onCode(null);
  }, [step, onCode]);
  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);

  const boxes = codeLength ?? 8;
  const complete = codeLength === null ? code.length >= 6 && code.length <= 8 : code.length === codeLength;

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault();
    setWorking(true);
    setError(undefined);
    const result = await session.start(email.trim(), mode);
    setWorking(false);
    if (!result.ok) return setError(result.error);
    setNote(step === "code" ? "A new code is on its way." : undefined);
    setCode("");
    setCodeLength(result.codeLength === undefined ? SIGN_IN_CODE_DIGITS : result.codeLength);
    setStep("code");
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError(undefined);
    const result = await session.verify(code);
    setWorking(false);
    if (!result.ok) {
      setError(result.error);
      if (result.restart) setCode("");
      return;
    }
    if (!result.signedIn) {
      // A new account was confirmed, and Cognito sends a sign-in code as well.
      setCode("");
      setCodeLength(SIGN_IN_CODE_DIGITS);
      setNote("Your account is ready. We’ve emailed you a sign-in code.");
    }
  };

  if (!account.available) {
    return (
      <section className="da-page da-signin-page">
        <div className="si-card si-unavailable">
          <span className="si-eyebrow">Your Haunt account</span>
          <h2 className="si-title">Sign-in isn’t set up here</h2>
          <p className="si-sub">This server has no sign-in, so everything works as a guest.</p>
        </div>
      </section>
    );
  }

  const qrDone = qr.status === "expired" || qr.status === "cancelled" || qr.status === "error";

  return (
    <section className="da-page da-signin-page">
      <div className="si-card">
        <header className="si-head">
          <span className="si-eyebrow">Your Haunt account</span>
          <h2 className="si-title">{step === "code" ? "Check your email" : mode === "signup" ? "Create your account" : "Sign in to Haunt"}</h2>
          <p className="si-sub">
            {step === "code" ? (
              <>
                We sent a code to <strong>{email.trim()}</strong>
              </>
            ) : (
              purpose === "community"
                ? "Sign in to listen to Community stories."
                : purpose === "create"
                  ? "Sign in to create your own story."
                  : "Save your stories, pick them up anywhere, and create your own."
            )}
          </p>
        </header>

        {account.testMode && (
          <p className="si-testmode" role="note">
            <strong>Test mode</strong> No email is sent on this computer. Your code appears in the terminal running{" "}
            <code>npm run dev</code>, on a line starting <code>[auth:mock]</code>.
          </p>
        )}

        <div className={`si-body${step === "code" ? " is-code" : ""}`}>
          {step === "email" && (
            <>
              <div className="si-panel si-qr-panel">
                <span className="si-panel-title">
                  <PhoneIcon /> Scan with your phone
                </span>
                <div className={`si-qr${qr.status === "waiting" ? " is-live" : ""}`}>
                  {qr.qr && !qrDone ? (
                    <img src={qr.qr.src} alt="QR code to sign in with your phone" />
                  ) : qrDone ? (
                    <button type="button" className="si-qr-retry" onClick={qr.restart}>
                      {qr.status === "error" ? "Couldn’t make a code." : "This code expired."}
                      <strong>Get a new code</strong>
                    </button>
                  ) : (
                    <span className="si-qr-loading" aria-label="Making your code" />
                  )}
                </div>
                {qr.qr && !qrDone && (
                  <p className="si-qr-code">
                    or go to <span>{qr.qr.verificationUri.replace(/^https?:\/\//, "")}</span> and enter
                    <strong>{qr.qr.userCode}</strong>
                  </p>
                )}
                <span className="si-status" role="status">
                  {qr.status === "waiting" && (
                    <>
                      <span className="si-dot" /> Waiting for your phone…
                    </>
                  )}
                  {qr.status === "approved" && "Approved. Signing you in…"}
                </span>
              </div>

              <div className="si-or" aria-hidden>
                <span>or</span>
              </div>
            </>
          )}

          <div className="si-panel si-email-panel">
            {step === "email" ? (
              <form className="si-form" onSubmit={sendCode}>
                <span className="si-panel-title">
                  <MailIcon /> Use your email
                </span>
                <div className="si-segment" role="tablist" aria-label="Account">
                  {(
                    [
                      ["signin", "Sign in"],
                      ["signup", "New account"],
                    ] as const
                  ).map(([id, label]) => (
                    <button key={id} type="button" role="tab" aria-selected={mode === id} className={mode === id ? "is-on" : undefined} onClick={() => setMode(id)}>
                      {label}
                    </button>
                  ))}
                </div>
                <label className="si-field">
                  <span>Email</span>
                  <input
                    id="da-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                </label>
                <button type="submit" className="si-primary" disabled={working || !email.trim()}>
                  {working ? "Sending…" : "Email me a code"}
                </button>
              </form>
            ) : (
              <form className="si-form" onSubmit={verify}>
                <label className="si-code" onClick={() => codeInput.current?.focus()}>
                  <span className="si-visually-hidden">Code</span>
                  <input
                    id="da-code"
                    ref={codeInput}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                  />
                  {Array.from({ length: boxes }, (_, i) => (
                    <span key={i} className={`si-box${code[i] ? " is-filled" : ""}${i === code.length ? " is-next" : ""}`} aria-hidden>
                      {code[i] ?? ""}
                    </span>
                  ))}
                </label>
                <p className="si-hint">Type it, or say “my code is 1 2 3 4…”</p>
                <button type="submit" className="si-primary" disabled={working || !complete}>
                  {working ? "Checking…" : "Sign in"}
                </button>
                <div className="si-links">
                  <button type="button" className="da-link" disabled={working} onClick={() => void sendCode()}>
                    Send a new code
                  </button>
                  <button
                    type="button"
                    className="da-link"
                    onClick={() => {
                      setStep("email");
                      setError(undefined);
                      setNote(undefined);
                    }}
                  >
                    Use a different email
                  </button>
                </div>
              </form>
            )}
            {note && <p className="si-note">{note}</p>}
            {error && (
              <p className="si-error" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.5 18.5h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
