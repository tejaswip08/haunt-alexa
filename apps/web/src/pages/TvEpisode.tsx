import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { MotionLevel } from "@haunt/scene-fx";
import { SceneArt } from "../components/SceneArt.tsx";
import { authorLabel } from "../lib/author.ts";
import { StoryEngagement } from "../components/StoryEngagement.tsx";
import { countPlayStart, saveProgress, type WatchingEntry } from "../lib/engagement.ts";
import { useSession } from "../lib/session.ts";
import { soundscape } from "../lib/soundscape.ts";
import { narrate, stopSpeaking, type Narration } from "../lib/speech.ts";

/** How a playthrough runs: decide along the way, or hear the main storyline straight through. */
export type PlayMode = "choices" | "listen";

/** A published episode, as play_episode returns it. */
export interface EpisodeView {
  kind: "episode";
  storyId: string;
  title: string;
  creator: string;
  summary: string;
  minutes: number;
  /** The main storyline as segment indexes, in order (what "Listen without choices" plays). */
  path?: number[];
  segments: EpisodeSegmentView[];
}

export interface EpisodeSegmentView {
  narration: string;
  mood: string;
  visualPrompt?: string;
  presentation?: unknown;
  choices?: { prompt: string; options: { label: string; next: number }[] };
  next?: number;
  ending?: boolean;
}

/** What list_library returns for each episode. */
export interface EpisodeSummary {
  storyId: string;
  title: string;
  summary: string;
  creator: string;
  minutes: number;
  parts?: number;
  /** Live totals (engagement.ts); null when the database isn't available. */
  likes?: number | null;
  plays?: number | null;
}

/** Where a saved playthrough stands, so a resume starts on the same part, and the same branch, as before. */
export type EpisodeResume = Pick<WatchingEntry, "partIndex" | "mode" | "segment" | "history">;

/** The scene a playthrough starts on: a resumed choices run continues its branch, a resumed listen run its part. */
function startingPoint(episode: EpisodeView, mode: PlayMode, resume?: EpisodeResume) {
  const path = episode.path ?? episode.segments.map((_, i) => i);
  if (mode === "choices" && resume?.history?.length) {
    return { at: resume.history[resume.history.length - 1] ?? 0, history: [...resume.history] };
  }
  if (mode === "listen" && resume) {
    return { at: path[Math.min(resume.partIndex, path.length - 1)] ?? 0, history: [] as number[] };
  }
  return { at: path[0] ?? 0, history: [] as number[] };
}

export interface EpisodeControls {
  /** The remote's Play/Pause key. */
  togglePause(): void;
  /** The remote's Pause key: holds the narration (no-op when already paused). */
  pause(): void;
  /** The remote's Play key: continues the narration (no-op when already playing). */
  resume(): void;
}

/** Asked before a new playthrough: interactive, or sit back and listen. The choice is remembered for the account. */
export function PlayModePicker(props: {
  episode: EpisodeView;
  /** The mode this listener used last time: its button gets the focus. */
  preferred?: PlayMode;
  onSelect: (mode: PlayMode) => void;
  onBack: () => void;
}) {
  const { episode } = props;
  const endings = episode.segments.filter((segment) => segment.ending).length;
  return (
    <div className="tv-scene tv-mode-picker">
      <div className="tv-story-head">
        <h2 className="tv-story-title">{episode.title}</h2>
        <p className="tv-story-kicker">
          <span>{authorLabel(episode.creator)}</span>
        </p>
        <p className="tv-art-caption">{episode.summary}</p>
      </div>
      <h3 className="tv-mode-question">How do you want to play?</h3>
      <div className="tv-choices">
        <button
          type="button"
          className="tv-button"
          data-focusable
          data-autofocus={props.preferred !== "listen" || undefined}
          onClick={() => props.onSelect("choices")}
        >
          Play with choices
        </button>
        <button
          type="button"
          className="tv-button"
          data-focusable
          data-autofocus={props.preferred === "listen" || undefined}
          onClick={() => props.onSelect("listen")}
        >
          Listen without choices
        </button>
        <button type="button" className="tv-button ghost" data-focusable onClick={props.onBack}>
          Back to stories
        </button>
      </div>
      <p className="tv-art-caption">
        {endings > 1 ? `${endings} endings to discover` : "Choices change how the story ends"}
      </p>
    </div>
  );
}

/**
 * Plays a library episode on the TV. "Listen without choices" narrates the main storyline straight through. "Play with
 * choices" stops at each decision, after the narration has finished, and follows the listener's pick.
 *
 * Controls are the same in both modes: Back (the previous segment on this playthrough, or out of the story from the first
 * one), Pause/Resume (the narration holds its place), and Forward or Next part. Choices appear above the bar.
 */
export function EpisodePlayer(props: {
  episode: EpisodeView;
  mode: PlayMode;
  /** A saved playthrough to continue. Omitted: a new one, which counts as a play. */
  resume?: EpisodeResume;
  motion: MotionLevel;
  onExit: () => void;
  /** Play again asks how to play, as Fire TV does. Without it, the same playthrough restarts in place. */
  onPlayAgain?: () => void;
  controlsRef: Ref<EpisodeControls>;
}) {
  const { episode, mode, resume } = props;
  const segments = episode.segments;
  const path = useMemo(() => episode.path ?? segments.map((_, i) => i), [episode.path, segments]);
  const account = useSession();
  const signedIn = account.status === "signed-in";
  const [start] = useState(() => startingPoint(episode, mode, resume));
  const [at, setAt] = useState(start.at);
  const [paused, setPaused] = useState(false);
  // Read by the narration effect, so a choice made while paused doesn't start the voice behind the pause.
  const pausedNow = useRef(false);
  // The narration in progress (one at a time). Undefined between narrations.
  const narrationNow = useRef<Narration | undefined>(undefined);
  // Bumped to start the current segment's narration again (resume with nothing in progress, or after a voice that couldn't hold its place).
  const [narrationKey, setNarrationKey] = useState(0);
  const [finished, setFinished] = useState(false);
  // Choices mode only: the narration has finished on a segment with options, and the listener is deciding.
  const [deciding, setDeciding] = useState(false);
  // True once this playback session has been counted. A resumed session isn't a new play; Play again counts again.
  const counted = useRef(resume !== undefined);
  // The segments this playthrough visited, in order: the branch a choices save records.
  const visited = useRef<number[]>(start.history);
  // Segments Back stepped over, nearest last: Forward walks them again. A new choice clears them (a new branch).
  const ahead = useRef<number[]>([]);
  const [aheadCount, setAheadCount] = useState(0);
  // The segments on this playthrough so far, in order. Part numbers come from this, not from segment indexes.
  const [trail, setTrail] = useState<number[]>(() => (start.history.length ? start.history : [start.at]));
  const segment = segments[at];

  /** The part after `index` on this playthrough, or undefined when the story ends there. */
  const nextAfter = (index: number): number | undefined => {
    if (mode === "listen") {
      const position = path.indexOf(index);
      return position >= 0 && position < path.length - 1 ? path[position + 1] : undefined;
    }
    const current = segments[index];
    if (!current || current.ending || current.choices) return undefined;
    const target = current.next ?? index + 1;
    return target < segments.length ? target : undefined;
  };

  /** Stops the narration in progress, as a cancellation (never as the part finishing). */
  const cancelNarration = () => {
    narrationNow.current?.cancel();
    narrationNow.current = undefined;
  };

  // Narrates the current segment. Only a narration that ends by itself moves the story on. A cancelled one (a pause the
  // voice can't hold, a choice, Back, leaving) and one whose effect was cleaned up never change the story.
  useEffect(() => {
    if (!segment || finished || deciding || pausedNow.current) return;
    // A play is the first narration of a session, not each segment, pause or resume.
    if (!counted.current) {
      counted.current = true;
      countPlayStart(episode.storyId);
    }
    soundscape.setScene(segment.mood);
    soundscape.duck(true);
    const narration = narrate(segment.narration);
    narrationNow.current = narration;
    let current = true;
    void narration.done.then((end) => {
      if (narrationNow.current === narration) narrationNow.current = undefined;
      if (!current || end !== "ended") return;
      soundscape.duck(false);
      if (mode === "choices" && segment.choices) return setDeciding(true);
      const next = nextAfter(at);
      if (next === undefined) setFinished(true);
      else {
        // Moving on by itself starts a new movement: the segments Back stepped over are no longer Forward targets.
        ahead.current = [];
        setAheadCount(0);
        setAt(next);
      }
    });
    return () => {
      current = false;
      narration.cancel();
      if (narrationNow.current === narration) narrationNow.current = undefined;
    };
    // nextAfter reads only the episode and mode, which the dependencies above already cover.
  }, [at, finished, deciding, segment, mode, narrationKey]);

  // Leaving the player always stops the voice and ambience.
  useEffect(
    () => () => {
      narrationNow.current?.cancel();
      narrationNow.current = undefined;
      stopSpeaking();
      soundscape.stop();
    },
    [],
  );

  // Keeps the trail of this playthrough (part numbers and Back depend on it) and, for a signed-in listener, saves where
  // they are whenever the segment changes. The completion is saved only at an ending.
  useEffect(() => {
    if (!segments[at]) return;
    if (mode === "listen") {
      if (signedIn) void saveProgress(episode.storyId, { partIndex: Math.max(0, path.indexOf(at)), completed: finished, mode: "listen" });
      return;
    }
    const list = visited.current;
    if (list[list.length - 1] !== at) list.push(at);
    setTrail([...list]);
    if (signedIn) {
      void saveProgress(episode.storyId, {
        // The part number along this branch (the server bounds it by the whole story, not the main storyline).
        partIndex: list.length - 1,
        completed: finished,
        mode: "choices",
        segment: at,
        history: [...list],
      });
    }
    // Runs on a segment change or the end only; the other props don't change what is recorded.
  }, [at, finished]);

  /** Pause holds the narration in place. Resume continues it, or starts this segment if nothing was speaking. */
  const togglePause = () => {
    if (finished) return;
    if (!pausedNow.current) {
      pausedNow.current = true;
      setPaused(true);
      soundscape.duck(false);
      const narration = narrationNow.current;
      // A voice that can't hold its place is stopped, and the segment starts again on resume.
      if (narration && !narration.pause()) cancelNarration();
      return;
    }
    pausedNow.current = false;
    setPaused(false);
    soundscape.duck(!deciding);
    if (narrationNow.current?.resume()) return;
    setNarrationKey((k) => k + 1);
  };
  useImperativeHandle(props.controlsRef, () => ({
    togglePause,
    pause: () => {
      if (!pausedNow.current) togglePause();
    },
    resume: () => {
      if (pausedNow.current) togglePause();
    },
  }));

  /** Next part (listening): skips the rest of this part. */
  const skip = () => {
    cancelNarration();
    pausedNow.current = false;
    setPaused(false);
    const next = nextAfter(at);
    if (next === undefined) setFinished(true);
    else setAt(next);
  };

  /** The segment before this one on this playthrough (listening: the one before it in the story). */
  const previousIndex = mode === "listen" ? path[path.indexOf(at) - 1] : trail[trail.length - 2];
  /** Back: the previous segment, with the branch kept so Forward can return. From the first segment, it leaves the story. */
  const goBack = () => {
    if (previousIndex === undefined) return props.onExit();
    cancelNarration();
    pausedNow.current = false;
    setPaused(false);
    setDeciding(false);
    if (mode === "choices") {
      const list = visited.current;
      ahead.current.push(list[list.length - 1] ?? at);
      list.pop();
      setAheadCount(ahead.current.length);
    }
    setAt(previousIndex);
  };
  /** Forward: walks back along the branch Back stepped over. */
  const goForward = () => {
    const next = ahead.current.pop();
    setAheadCount(ahead.current.length);
    if (next === undefined) return;
    cancelNarration();
    pausedNow.current = false;
    setPaused(false);
    setDeciding(false);
    setAt(next);
  };
  const choose = (target: number) => {
    cancelNarration();
    // A new choice starts a new branch, so the segments Back stepped over are no longer ahead.
    ahead.current = [];
    setAheadCount(0);
    setDeciding(false);
    setAt(target);
  };
  const restart = () => {
    cancelNarration();
    counted.current = false;
    visited.current = [];
    ahead.current = [];
    setAheadCount(0);
    setTrail([path[0] ?? 0]);
    pausedNow.current = false;
    setPaused(false);
    setFinished(false);
    setDeciding(false);
    setAt(path[0] ?? 0);
  };

  if (!segment) return null;
  // Part numbers follow the path this listener actually took. A choices run that has left the main storyline has no
  // total, because the story's length on that branch isn't fixed by the main path.
  const onMainStoryline = trail.length <= path.length && trail.every((segmentIndex, i) => path[i] === segmentIndex);
  const position = mode === "listen" ? path.indexOf(at) + 1 : trail.length;
  const showTotal = mode === "listen" || onMainStoryline;
  const partLabel = showTotal ? `Part ${position} of ${path.length}` : `Part ${position}`;
  const progressShare = showTotal ? Math.min(1, position / path.length) : undefined;
  const endingSegments = segments.filter((s) => s.ending).length;
  const onLastPart = nextAfter(at) === undefined;
  return (
    <>
      <div className="tv-art-layer" key={`${episode.storyId}-${at}`}>
        <SceneArt
          className="tv-art"
          image={null}
          presentation={segment.presentation}
          mood={segment.mood}
          motion={props.motion}
        />
      </div>
      <div className="tv-scene">
        <div className="tv-scene-top">
          <div className="tv-nav-row">
            <button type="button" className="tv-back-link" data-focusable onClick={props.onExit}>
              <span aria-hidden>←</span> Back to Stories
            </button>
            <StoryEngagement storyId={episode.storyId} focusable />
          </div>
          <div className="tv-story-head">
            <h2 className="tv-story-title">{episode.title}</h2>
            <p className="tv-story-kicker">
              <span className="kicker-part">
                {finished ? "The end" : partLabel}
                {paused ? " · paused" : ""}
              </span>
              <span className="kicker-dot" aria-hidden>•</span>
              <span>{authorLabel(episode.creator)}</span>
              {mode === "choices" && <span className="kicker-dot" aria-hidden>•</span>}
              {mode === "choices" && <span>{endingSegments > 1 ? `${endingSegments} endings` : "Play with choices"}</span>}
            </p>
            {progressShare !== undefined && !finished && (
              <div className="tv-progress" role="progressbar" aria-label="Story progress" aria-valuemin={0} aria-valuemax={path.length} aria-valuenow={position}>
                <span style={{ width: `${Math.round(progressShare * 100)}%` }} />
              </div>
            )}
          </div>
        </div>
        <div className="tv-scene-body">
          {segment.visualPrompt && <p className="tv-art-caption">Illustration · {segment.visualPrompt}</p>}
          <div className={`tv-narration${segment.narration.length > 520 ? " is-long" : ""}`} key={at}>
            {segment.narration.split(/\n+/).map((paragraph, i) => (
              <p key={i} style={{ animationDelay: `${Math.min(i * 0.25, 1)}s` }}>
                {paragraph}
              </p>
            ))}
          </div>
          {deciding && segment.choices && <p className="tv-art-caption">{segment.choices.prompt}</p>}
        </div>
        {/* One column, always rendered: the choices (when deciding) stack above the bar, so neither can push the other off screen. */}
        {finished ? (
          <div className="tv-controls">
            <div className="tv-choices">
              <button type="button" className="tv-button" data-focusable data-autofocus onClick={props.onExit}>
                Back to stories
              </button>
              <button type="button" className="tv-button ghost" data-focusable onClick={props.onPlayAgain ?? restart}>
                Play again
              </button>
            </div>
          </div>
        ) : (
          <div className="tv-controls" role="group" aria-label="Playback controls">
            {deciding && segment.choices && (
              <div className="tv-choices" role="group" aria-label="What happens next">
                {segment.choices.options.map((option, k) => (
                  <button
                    key={option.next}
                    type="button"
                    className="tv-button"
                    data-focusable
                    data-autofocus={k === 0 || undefined}
                    onClick={() => choose(option.next)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            <div className="tv-player-bar">
              <button
                type="button"
                className="tv-button ghost"
                data-focusable
                onClick={goBack}
                aria-label={previousIndex === undefined ? "Leave the story" : "Back to the previous turn"}
              >
                <span aria-hidden>‹</span> {previousIndex === undefined ? "Leave" : "Back"}
              </button>
              <button
                type="button"
                className="tv-button"
                data-focusable
                data-autofocus={!deciding || undefined}
                aria-pressed={paused}
                aria-label={paused ? "Resume narration" : "Pause narration"}
                onClick={togglePause}
              >
                <span aria-hidden>{paused ? "▶" : "❚❚"}</span> {paused ? "Resume" : "Pause"}
              </button>
              {mode === "choices" && aheadCount > 0 && (
                <button type="button" className="tv-button ghost" data-focusable onClick={goForward} aria-label="Forward to the turn you left">
                  Forward <span aria-hidden>›</span>
                </button>
              )}
              {mode === "listen" && (
                <button
                  type="button"
                  className="tv-button ghost"
                  data-focusable
                  onClick={skip}
                  aria-label={onLastPart ? "Finish the story" : "Skip to the next part"}
                >
                  {onLastPart ? "Finish" : "Next part"} <span aria-hidden>›</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
