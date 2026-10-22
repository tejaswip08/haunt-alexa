import { useEffect, useRef, useState } from "react";
import { Logo } from "../components/Logo.tsx";
import { SceneArt, type SceneImage } from "../components/SceneArt.tsx";
import {
  EpisodePlayer,
  PlayModePicker,
  type EpisodeControls,
  type EpisodeResume,
  type EpisodeSummary,
  type EpisodeView,
  type PlayMode,
} from "./TvEpisode.tsx";
import { focusFirst, installDpad } from "../lib/dpad.ts";
import { MOTION_LABEL, useMotion } from "../lib/motion.ts";
import { fetchLibrary } from "../lib/library-data.ts";
import { connectHaunt } from "../lib/mcp.ts";
import { navigate } from "../router.tsx";
import { fetchAccountLibrary, fetchTotals, setPlayMode, TOTALS_POLL_MS, usePoll, type WatchingEntry } from "../lib/engagement.ts";
import { soundscape } from "../lib/soundscape.ts";
import { describeListenFailure } from "../lib/recognition.ts";
import {
  canListen,
  checkVoice,
  currentEngine,
  finishListening,
  listen,
  ListenError,
  speak,
  stopListening,
  stopSpeaking,
  voiceUnavailableReason,
} from "../lib/speech.ts";
import { describeChoices, routeSpokenReply } from "../lib/voice-intent.ts";

/** The scene fields the TV uses from a Haunt scene tool's structuredContent. */
interface SceneView {
  storyId: string;
  title: string;
  sceneNumber: number;
  totalScenes: number;
  status: "active" | "completed";
  mood: string;
  narration: string;
  question: string | null;
  suggestions: string[];
  soundCues: string[];
  visualPrompt: string;
  image?: SceneImage | null;
  /** Setting and allowlisted effects, chosen by the server. Validated again before drawing. */
  presentation?: unknown;
}

const PREMISES = [
  { title: "The Last Train", premise: "The last train from an empty station, and the conductor who knows my name" },
  { title: "Ward Seven", premise: "A night shift in an abandoned hospital where the call buttons still ring" },
  { title: "The Keeper", premise: "A lighthouse on a dead island that lights itself every night" },
  { title: "Basement Tapes", premise: "Old cassette tapes in my grandmother's basement, labelled with tomorrow's dates" },
];

const LENGTHS = [
  { id: "short", label: "Short · 4 turns" },
  { id: "medium", label: "Medium · 6 turns" },
  { id: "long", label: "Long · 8 turns" },
] as const;

type Screen =
  | { kind: "home" }
  | { kind: "loading"; line: string; previous?: SceneView }
  | { kind: "scene"; scene: SceneView }
  | { kind: "error"; message: string; retry: () => void }
  | { kind: "choose-mode"; episode: EpisodeView; preferred?: PlayMode }
  | { kind: "episode"; episode: EpisodeView; mode: PlayMode; resume?: EpisodeResume };

async function callScene(name: string, input: Record<string, unknown>): Promise<SceneView> {
  const connection = await connectHaunt();
  const result = await connection.call(name, input).result;
  const data = result.structuredContent as (SceneView & { error?: string }) | undefined;
  if (result.isError || !data?.narration) {
    const text = result.content?.find((c) => c.type === "text");
    throw new Error(data?.error ?? (text && "text" in text ? text.text : "The story could not continue."));
  }
  return data;
}

export function Tv() {
  const [screen, setScreen] = useState<Screen>({ kind: "home" });
  const [length, setLength] = useState<(typeof LENGTHS)[number]["id"]>("short");
  const [narrating, setNarrating] = useState(false);
  const motion = useMotion();
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const narratingRef = useRef(narrating);
  narratingRef.current = narrating;
  const [voiceStatus, setVoiceStatus] = useState<Awaited<ReturnType<typeof checkVoice>>>();
  useEffect(() => {
    if (canListen) void checkVoice().then(setVoiceStatus);
  }, []);
  const voiceReady = canListen && voiceStatus?.available !== false;
  const voiceReason = canListen ? (voiceStatus?.available === false ? voiceStatus.message : "") : voiceUnavailableReason;
  const [voice, setVoice] = useState<VoiceUi>({ listening: false, heard: "", note: null, pending: null });

  const narrate = async (scene: SceneView) => {
    setNarrating(true);
    soundscape.duck(true);
    try {
      await speak(scene.question ? `${scene.narration}\n\n${scene.question}` : scene.narration);
    } finally {
      soundscape.duck(false);
      setNarrating(false);
    }
  };

  const show = (scene: SceneView) => {
    setVoice(idleVoice);
    setScreen({ kind: "scene", scene });
    soundscape.setScene(scene.mood, scene.soundCues);
    void narrate(scene);
  };

  const run = (line: string, request: () => Promise<SceneView>, previous?: SceneView) => {
    stopSpeaking();
    setScreen({ kind: "loading", line, previous });
    request().then(show, (error: Error) =>
      setScreen({ kind: "error", message: error.message, retry: () => run(line, request, previous) }),
    );
  };

  const start = (premise: string) => {
    soundscape.unlock();
    run("Summoning your story…", () => callScene("start_story", { premise, length }));
  };

  const answer = (scene: SceneView, choice: string) =>
    run("The story is shifting…", () => callScene("answer_story", { storyId: scene.storyId, answer: choice }), scene);

  const end = (scene: SceneView) =>
    run("Writing the ending…", () => callScene("end_story", { storyId: scene.storyId }), scene);

  /** Listen for one spoken reply, then act on it. The D-pad choices stay available throughout. */
  /** Listen for one spoken reply, then act on it. The D-pad choices stay available throughout. */
  /**
   * Listen for one spoken reply. Commands ("repeat that") act at once; a story answer waits
   * for the listener to confirm it, so a misheard transcript never changes the story.
   * The D-pad choices stay available throughout.
   */
  const speakAnswer = async (scene: SceneView) => {
    if (voice.listening) {
      finishListening();
      return;
    }
    stopSpeaking();
    setVoice({ listening: true, heard: "", note: null, pending: null });
    try {
      const said = await listen((heard) => setVoice((v) => ({ ...v, heard })));
      routeSpokenReply(said, {
        repeat: () => (setVoice(idleVoice), void narrate(scene)),
        choices: () => (setVoice(idleVoice), void speak(describeChoices(scene.suggestions))),
        end: () => (setVoice(idleVoice), end(scene)),
        answer: (text) => setVoice({ listening: false, heard: text, note: null, pending: text }),
      });
    } catch (error) {
      const code = error instanceof ListenError ? error.code : (error as Error)?.name || "unknown";
      const status = describeListenFailure(code, voiceStatus?.env ?? undefined);
      // The browser's own speech service failed, but Haunt's server can take over next time.
      const switched = code === "network" && currentEngine() === "server";
      const note = switched
        ? "Your browser's speech service isn't available, so Haunt will use its own. Press “Speak an answer” again."
        : status.message
          ? `${status.message} (${code})`
          : null;
      setVoice({ listening: false, heard: "", note, pending: null });
      // Retrying can't help when the microphone or every speech service is unavailable.
      if (!status.available && !switched) {
        setVoiceStatus((current) => ({ ...status, message: `${status.message} (${code})`, env: current?.env ?? null }));
      }
    }
  };

  const sendPending = (scene: SceneView) => {
    const text = voice.pending;
    setVoice(idleVoice);
    if (text) answer(scene, text);
  };

  // The library of published episodes, refreshed whenever the home screen shows.
  const [library, setLibrary] = useState<EpisodeSummary[] | null>(null);
  const libraryRef = useRef<EpisodeSummary[] | null>(null);
  libraryRef.current = library;
  const episodeControls = useRef<EpisodeControls>(null);
  useEffect(() => {
    if (screen.kind !== "home") return;
    let live = true;
    connectHaunt()
      .then((c) => fetchLibrary(c.client))
      .then((cards) => {
        if (live) setLibrary(cards);
      })
      .catch(() => live && setLibrary([]));
    return () => {
      live = false;
    };
  }, [screen.kind]);
  // Play and like totals refresh while the home screen shows; the story list itself isn't refetched.
  usePoll(
    () => {
      const ids = libraryRef.current?.map((episode) => episode.storyId) ?? [];
      fetchTotals(ids)
        .then((totals) =>
          setLibrary((list) => list && list.map((e) => (totals[e.storyId] ? { ...e, ...totals[e.storyId] } : e))),
        )
        .catch(() => {});
    },
    TOTALS_POLL_MS,
    screen.kind === "home",
  );

  /**
   * Opens a library episode. A new playthrough asks how to play first, with the mode used last time preselected.
   * A resume goes straight back to the saved mode and place (a choices run keeps its branch).
   */
  const openEpisode = (storyId: string, resume?: WatchingEntry) => {
    soundscape.unlock();
    stopSpeaking();
    setScreen({ kind: "loading", line: "Opening the episode…" });
    connectHaunt()
      .then((c) => c.client.callTool({ name: "play_episode", arguments: { storyId } }))
      .then(async (result) => {
        const episode = result.structuredContent as EpisodeView | undefined;
        if (result.isError || episode?.kind !== "episode" || !episode.segments?.length) {
          throw new Error("That episode isn't available any more.");
        }
        // Resume only where the saved mode is known: a branch run with its history, or a listen run. A record saved before
        // the mode was recorded (mode null) is not guessed as listen; the mode question is asked instead.
        const branchResume = resume?.mode === "choices" && (resume.history?.length ?? 0) > 0;
        if (resume && (branchResume || resume.mode === "listen")) {
          const mode: PlayMode = branchResume ? "choices" : "listen";
          return setScreen({ kind: "episode", episode, mode, resume });
        }
        const library = await fetchAccountLibrary().catch(() => null);
        setScreen({ kind: "choose-mode", episode, preferred: library?.modes[storyId] });
      })
      .catch((error: Error) => setScreen({ kind: "error", message: error.message, retry: () => openEpisode(storyId, resume) }));
  };

  // Deep links from the rest of the site: /tv?episode=<id> asks how to play; /tv?resume=<id> continues a saved playthrough.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const episodeId = query.get("episode");
    const resumeId = query.get("resume");
    if (episodeId) return openEpisode(episodeId);
    if (resumeId) {
      fetchAccountLibrary()
        .then((library) => {
          const item = library?.continueWatching.find((entry) => entry.storyId === resumeId);
          if (item) openEpisode(resumeId, item);
        })
        .catch(() => undefined);
    }
    // Runs once, when the page opens with a link.
  }, []);

  const home = () => {
    stopListening();
    setVoice(idleVoice);
    stopSpeaking();
    soundscape.stop();
    setScreen({ kind: "home" });
  };

  useEffect(
    () =>
      installDpad({
        onBack: () => {
          if (screenRef.current.kind === "home") return false;
          home();
          return true;
        },
        onPlayPause: (key) => {
          const current = screenRef.current;
          if (current.kind === "episode") {
            // Pause and Play keys hold and continue; the Play/Pause toggle key flips.
            const controls = episodeControls.current;
            if (key === "MediaPause") return controls?.pause();
            if (key === "MediaPlay") return controls?.resume();
            return controls?.togglePause();
          }
          if (current.kind !== "scene") return;
          if (narratingRef.current) stopSpeaking();
          else void narrate(current.scene);
        },
      }),
    [],
  );

  // Put remote focus somewhere sensible whenever the screen or the voice step changes
  // (the review step replaces the buttons, so focus would otherwise be lost).
  useEffect(() => {
    const timer = setTimeout(focusFirst, 50);
    return () => clearTimeout(timer);
  }, [screen, voice.pending]);

  return (
    <div className={`tv tv-mood-${screen.kind === "scene" ? screen.scene.mood : "uneasy"}`}>
      <div className="tv-backdrop" aria-hidden />
      {screen.kind === "home" && (
        <HomeScreen
          length={length}
          onLength={setLength}
          onStart={start}
          voiceReady={voiceReady}
          voiceReason={voiceReason}
          motionLabel={`${MOTION_LABEL[motion.preference]}${motion.preference === "auto" ? ` (${motion.level})` : ""}`}
          onMotion={motion.cycle}
          library={library}
          onEpisode={openEpisode}
        />
      )}
      {screen.kind === "choose-mode" && (
        <PlayModePicker
          episode={screen.episode}
          preferred={screen.preferred}
          onBack={home}
          onSelect={(mode) => {
            const { episode } = screen;
            // Remembered for the signed-in account; signed out, the server refuses and nothing is kept.
            void setPlayMode(episode.storyId, mode);
            setScreen({ kind: "episode", episode, mode });
          }}
        />
      )}
      {screen.kind === "episode" && (
        <EpisodePlayer
          episode={screen.episode}
          mode={screen.mode}
          resume={screen.resume}
          onPlayAgain={() => setScreen({ kind: "choose-mode", episode: screen.episode, preferred: screen.mode })}
          motion={motion.level}
          onExit={home}
          controlsRef={episodeControls}
        />
      )}
      {screen.kind === "loading" && (
        <div className="tv-center">
          {screen.previous && <div className="tv-eyebrow">{screen.previous.title}</div>}
          <div className="tv-spinner" aria-hidden />
          <p className="tv-loading" role="status">
            {screen.line}
          </p>
        </div>
      )}
      {screen.kind === "error" && (
        <div className="tv-center">
          <h1 className="tv-title">The candle went out</h1>
          <p className="tv-lede">{screen.message}</p>
          <div className="tv-row">
            <button type="button" className="tv-button" data-focusable data-autofocus onClick={screen.retry}>
              Try again
            </button>
            <button type="button" className="tv-button ghost" data-focusable onClick={home}>
              Back to stories
            </button>
          </div>
        </div>
      )}
      {screen.kind === "scene" && (
        <div className="tv-art-layer" key={`${screen.scene.storyId}-${screen.scene.sceneNumber}`}>
          <SceneArt
            className="tv-art"
            image={screen.scene.image}
            presentation={screen.scene.presentation}
            mood={screen.scene.mood}
            motion={motion.level}
          />
        </div>
      )}
      {screen.kind === "scene" && (
        <SceneScreen
          scene={screen.scene}
          narrating={narrating}
          onChoice={(choice) => answer(screen.scene, choice)}
          onEnd={() => end(screen.scene)}
          onReplay={() => void narrate(screen.scene)}
          onSkip={stopSpeaking}
          onHome={home}
          voice={
            voiceReady
              ? {
                  ...voice,
                  onSpeak: () => void speakAnswer(screen.scene),
                  onCancel: () => (stopListening(), setVoice(idleVoice)),
                  onSend: () => sendPending(screen.scene),
                  onRetry: () => void speakAnswer(screen.scene),
                }
              : undefined
          }
          voiceReason={voiceReason}
        />
      )}
    </div>
  );
}

interface VoiceUi {
  listening: boolean;
  /** Live words while listening, or a status like "Transcribing…". */
  heard: string;
  note: string | null;
  /** A recognised answer waiting for the listener to send it. */
  pending: string | null;
}
const idleVoice: VoiceUi = { listening: false, heard: "", note: null, pending: null };

function HomeScreen(props: {
  length: string;
  onLength: (id: (typeof LENGTHS)[number]["id"]) => void;
  onStart: (premise: string) => void;
  motionLabel: string;
  onMotion: () => void;
  voiceReady: boolean;
  voiceReason: string;
  /** Published episodes; null while loading. The row is hidden when there are none. */
  library: EpisodeSummary[] | null;
  onEpisode: (storyId: string) => void;
}) {
  return (
    <div className="tv-home">
      <header>
        <Logo className="tv-logo" size={96} />
        <p className="tv-lede">Stories that listen back. Pick a story, then decide what happens next.</p>
      </header>
      <div className="tv-cards">
        {PREMISES.map((item, i) => (
          <button
            key={item.title}
            type="button"
            className={`tv-card tv-card-${i}`}
            data-focusable
            data-autofocus={i === 0 || undefined}
            onClick={() => props.onStart(item.premise)}
          >
            <span className="tv-card-title">{item.title}</span>
            <span className="tv-card-premise">{item.premise}</span>
          </button>
        ))}
      </div>
      <p className="tv-voice-hint" role="note">
        {props.voiceReady
          ? "🎙 Voice answers are on: choose “Speak an answer” on any turn, or use the remote."
          : `Voice answers are off here. ${props.voiceReason}`}
      </p>
      {props.library && props.library.length > 0 && (
        <section className="tv-library" aria-label="Library">
          <span className="tv-eyebrow">
            From the library · {props.library.length} {props.library.length === 1 ? "story" : "stories"} · narrated straight
            through
          </span>
          <div className="tv-library-row">
            {/* Every published story: the row scrolls sideways as the remote moves along it. */}
            {props.library.map((episode) => (
              <button
                key={episode.storyId}
                type="button"
                className="tv-episode"
                data-focusable
                onClick={() => props.onEpisode(episode.storyId)}
              >
                <span className="tv-episode-title">{episode.title}</span>
                <span className="tv-episode-meta">
                  {episode.minutes} min{episode.parts ? ` · ${episode.parts} parts` : ""} · by {episode.creator}
                </span>
                {episode.plays != null && (
                  <span className="tv-episode-meta">
                    ▶ {episode.plays.toLocaleString()} plays
                    {episode.likes != null ? ` · ♥ ${episode.likes.toLocaleString()}` : ""}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="tv-row">
        <span className="tv-eyebrow">Length</span>
        {LENGTHS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`tv-chip${props.length === option.id ? " is-selected" : ""}`}
            aria-pressed={props.length === option.id}
            data-focusable
            onClick={() => props.onLength(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="tv-footer">
        <p className="tv-hint">◀ ▶ ▲ ▼ to move · Select to choose · Back to return · ⏯ to replay narration</p>
        <button type="button" className="tv-chip tv-legal" data-focusable onClick={props.onMotion}>
          Animations: {props.motionLabel}
        </button>
        <button type="button" className="tv-chip tv-legal" data-focusable onClick={() => navigate("/privacy?tv")}>
          Privacy &amp; terms
        </button>
      </div>
    </div>
  );
}

function SceneScreen(props: {
  scene: SceneView;
  narrating: boolean;
  onChoice: (choice: string) => void;
  onEnd: () => void;
  onReplay: () => void;
  onSkip: () => void;
  onHome: () => void;
  /** Present only when this device can recognise speech. */
  voice?: VoiceUi & { onSpeak: () => void; onCancel: () => void; onSend: () => void; onRetry: () => void };
  /** Why voice is off, shown in place of the Speak button. */
  voiceReason: string;
}) {
  const { scene } = props;
  const ended = scene.status === "completed" || !scene.question;
  return (
    <div className="tv-scene">
      <div className="tv-scene-top">
        <span className="tv-eyebrow">{scene.title}</span>
        <span className="tv-eyebrow">
          {ended ? "The end" : `Turn ${scene.sceneNumber} of ${scene.totalScenes}`}
        </span>
      </div>
      <div className="tv-scene-body">
        <p className="tv-art-caption">
          {scene.image?.generated ? "AI-generated image" : "Illustration"} · {scene.visualPrompt}
        </p>
        <div className={`tv-narration${scene.narration.length > 520 ? " is-long" : ""}`}>
          {scene.narration.split(/\n+/).map((paragraph, i) => (
            // Paragraphs arrive in quick succession: the whole scene is readable within about a second.
            <p key={i} style={{ animationDelay: `${Math.min(i * 0.25, 1)}s` }}>
              {paragraph}
            </p>
          ))}
        </div>
        {scene.question && <p className="tv-question">{scene.question}</p>}
        {!props.voice && !ended && props.voiceReason && <p className="tv-voice-status">{props.voiceReason}</p>}
        {props.voice && (props.voice.listening || props.voice.note) && (
          <p className="tv-voice-status" role="status" aria-live="polite">
            {props.voice.listening ? `Listening… ${props.voice.heard}` : props.voice.note}
          </p>
        )}
        {props.voice?.pending && (
          <p className="tv-voice-status tv-voice-pending" role="status" aria-live="polite">
            You said: “{props.voice.pending}”
          </p>
        )}
      </div>
      <div className="tv-choices">
        {props.voice?.pending ? (
          <>
            <button type="button" className="tv-button tv-speak" data-focusable data-autofocus onClick={props.voice.onSend}>
              Send answer
            </button>
            <button type="button" className="tv-button" data-focusable onClick={props.voice.onRetry}>
              Try again
            </button>
            <button type="button" className="tv-button ghost" data-focusable onClick={props.voice.onCancel}>
              Cancel
            </button>
          </>
        ) : ended ? (
          <button type="button" className="tv-button" data-focusable data-autofocus onClick={props.onHome}>
            Another story
          </button>
        ) : (
          <>
            {scene.suggestions.map((choice, i) => (
              <button
                key={choice}
                type="button"
                className="tv-button"
                data-focusable
                data-autofocus={i === 0 || undefined}
                onClick={() => props.onChoice(choice)}
              >
                {choice}
              </button>
            ))}
            {props.voice && !props.voice.pending && (
              <button
                type="button"
                className={`tv-button tv-speak${props.voice.listening ? " is-listening" : ""}`}
                data-focusable
                aria-pressed={props.voice.listening}
                onClick={props.voice.onSpeak}
              >
                {props.voice.listening ? "Done" : "Speak an answer"}
              </button>
            )}
            {props.voice?.listening && (
              <button type="button" className="tv-button ghost" data-focusable onClick={props.voice.onCancel}>
                Cancel
              </button>
            )}
            <button type="button" className="tv-button ghost" data-focusable onClick={props.onEnd}>
              End the story
            </button>
          </>
        )}
        <button
          type="button"
          className="tv-button ghost"
          data-focusable
          onClick={props.narrating ? props.onSkip : props.onReplay}
        >
          {props.narrating ? "Skip narration" : "Replay narration"}
        </button>
      </div>
    </div>
  );
}
