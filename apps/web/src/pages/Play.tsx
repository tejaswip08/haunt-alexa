import { useEffect, useRef, useState } from "react";
import { DeviceApp } from "../components/DeviceApp.tsx";
import { DeviceFrame } from "../components/DeviceFrame.tsx";
import { StoryEngagement } from "../components/StoryEngagement.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { SceneStack } from "../components/SceneStack.tsx";
import { device, useDevice, type DeviceState } from "../lib/device.ts";
import type { HauntConnection } from "../lib/mcp.ts";
import { soundscape } from "../lib/soundscape.ts";
import { navigate } from "../router.tsx";
import { canListen, stopSpeaking, voiceUnavailableReason } from "../lib/speech.ts";
import { fetchAccountLibrary } from "../lib/engagement.ts";

const STATUS: Record<DeviceState, string> = {
  connecting: "Connecting to Haunt…",
  idle: "Tap the mic and speak",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Narrating · tap the mic to interrupt",
  error: "Something went wrong",
};

export function Play() {
  const snapshot = useDevice();
  const [connection, setConnection] = useState<HauntConnection>();
  const [speakerOnly, setSpeakerOnly] = useState(false);
  const [ambience, setAmbience] = useState(soundscape.enabled);
  const [lightScreen, setLightScreen] = useState(false);
  const mode = useServerMode();
  // The story opened from the library (?episode=…&from=library). Read once: the address is tidied on mount below.
  const [episodeId] = useState(() => new URLSearchParams(window.location.search).get("episode"));
  const [origin] = useState(() => new URLSearchParams(window.location.search).get("from"));
  const leaving = useRef(false);
  // Back returns to where the story was opened from; with no known origin, to the library.
  const backTarget = origin === "tv" ? "/tv" : origin === "home" ? "/" : "/library";

  /** Stops the narration and returns. Never ends, submits, or resets the story; a second tap does nothing. */
  const goBack = () => {
    if (leaving.current) return;
    leaving.current = true;
    stopSpeaking();
    soundscape.stop();
    navigate(backTarget);
  };

  useEffect(() => {
    device.connect().then(setConnection, () => {});
    // Lets the demo be driven from the browser console: haunt.say("…")
    (window as unknown as { haunt: unknown }).haunt = { say: (text: string) => device.say(text), hear: (text: string) => device.hear(text), soundscape };
    const params = new URLSearchParams(window.location.search);
    const pending = params.get("say");
    const episode = params.get("episode");
    const resume = params.get("resume");
    if (pending || episode || resume) window.history.replaceState(null, "", "/alexa");
    if (episode) {
      // A published story plays through the same flow as /tv: the mode question, account progress and resume.
      window.location.replace(`/tv?episode=${encodeURIComponent(episode)}`);
      return;
    }
    if (resume) {
      // A saved library story resumes through /tv. Anything else is one of the listener's own stories, resumed on the device.
      fetchAccountLibrary()
        .then((library) => {
          const isLibraryStory = library?.continueWatching.some((entry) => entry.storyId === resume) ?? false;
          if (isLibraryStory) window.location.replace(`/tv?resume=${encodeURIComponent(resume)}`);
          else void device.resumeStory(resume);
        })
        .catch(() => void device.resumeStory(resume));
    } else if (pending) void device.say(pending);
  }, []);

  const { state, heard, view, error } = snapshot;
  const live = mode && mode.story === "live" && mode.agent === "live";

  return (
    <div className="play">
      {episodeId && (
        <div className="play-topbar">
          <button type="button" className="play-back" onClick={goBack} aria-label="Back">
            <span aria-hidden>←</span> Back
          </button>
          <StoryEngagement storyId={episodeId} />
        </div>
      )}
      <header className="play-hero">
        <span className="eyebrow">Alexa+ · Live MCP demo</span>
        <h1>Talk to Haunt</h1>
        <p className="play-hero-sub">Ask for a story out loud. Every MCP message appears in the inspector as it happens.</p>
        <ul className="meta-pills" aria-label="Connection">
          <li>MCP {connection?.protocolVersion ?? "2025-11-25"}</li>
          <li>Streamable HTTP</li>
          {mode && <li className={live ? "is-live" : undefined}>{live ? "Claude on Amazon Bedrock" : "Scripted demo"}</li>}
          {mode?.tts && <li>{mode.tts.startsWith("polly") ? "Amazon Polly voice" : "Browser voice"}</li>}
        </ul>
      </header>
      <div className="stage">
        <div className="device-switch" role="group" aria-label="Device">
          <button type="button" aria-pressed={!speakerOnly} onClick={() => setSpeakerOnly(false)}>
            <ScreenIcon /> Echo Show <span>with screen</span>
          </button>
          <button type="button" aria-pressed={speakerOnly} onClick={() => setSpeakerOnly(true)}>
            <SpeakerIcon /> Echo <span>voice only</span>
          </button>
        </div>

        {speakerOnly ? (
          <SpeakerDevice state={state} heard={heard} spoken={snapshot.spoken} />
        ) : (
          <DeviceFrame state={state}>
            {view && connection ? (
              <SceneStack
                call={view}
                connection={connection}
                theme={lightScreen ? "light" : "dark"}
                onUserMessage={(text) => device.say(text)}
              />
            ) : (
              <DeviceApp
                connection={connection}
                onSay={(text) => void device.hear(text)}
                onPlay={(storyId) => void device.playEpisode(storyId)}
                onStart={(input) => void device.startStory(input)}
                onVoice={(router) => device.setVoiceRouter(router)}
                onResume={(storyId) => void device.resumeStory(storyId)}
              />
            )}
            {(state === "listening" || (heard && state === "thinking")) && (
              <div className="heard" aria-live="polite">
                {heard || "…"}
              </div>
            )}
          </DeviceFrame>
        )}

        <div className="controls">
          <button
            type="button"
            className={`mic mic-${state}`}
            onClick={() => device.talk()}
            disabled={!canListen || state === "connecting"}
            aria-pressed={state === "listening"}
            aria-label={state === "listening" ? "Stop listening" : "Talk to Haunt"}
          >
            <MicIcon />
          </button>
          <p className="status" role="status">
            {error ?? (canListen ? STATUS[state] : voiceUnavailableReason)}
          </p>
          <div className="toggles">
            <label className="switch">
              <input
                type="checkbox"
                checked={ambience}
                onChange={(e) => {
                  soundscape.setEnabled(e.target.checked);
                  setAmbience(e.target.checked);
                }}
              />
              <span>Ambience</span>
            </label>
            {!speakerOnly && (
              <label className="switch">
                <input type="checkbox" checked={lightScreen} onChange={(e) => setLightScreen(e.target.checked)} />
                <span>Light screen</span>
              </label>
            )}
            <button type="button" className="tv-button small" onClick={() => device.reset()}>
              Reset demo
            </button>
          </div>
          {mode && (mode.story === "demo" || mode.agent === "demo") && (
            <p className="demo-badge" role="note">
              Demo mode: {mode.agent === "demo" ? "the assistant" : ""}
              {mode.agent === "demo" && mode.story === "demo" ? " and " : ""}
              {mode.story === "demo" ? "the story writer" : ""} {mode.agent === "demo" && mode.story === "demo" ? "are" : "is"}{" "}
              scripted, not Claude.
            </p>
          )}
          {/* In the one-column layout the inspector sits below the device; this jumps to it. */}
          <a className="inspector-jump" href="#inspector">
            Live MCP inspector ↓
          </a>
          <p className="footnote">
            {speakerOnly
              ? "Simulated Alexa+ speaker with no screen: the same MCP tools, told by voice alone. Captions are shown here for the demo."
              : "Simulated Alexa+ device with a screen: the scene view is an MCP App rendered on the display."}{" "}
            Scenes are narrated word for word by Amazon Polly; Alexa+ today voices add-on results in its own words.
          </p>
        </div>
      </div>
      <Inspector protocolVersion={connection?.protocolVersion} />
    </div>
  );
}

interface ServerMode {
  story: "live" | "demo";
  agent: "live" | "demo";
  /** "browser", or "polly:<voice>/<engine>". */
  tts?: string;
}

/** Whether Claude or the offline stand-ins are answering, and who narrates, from /api/health. */
function useServerMode(): ServerMode | undefined {
  const [mode, setMode] = useState<ServerMode>();
  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((health: { mode?: ServerMode; tts?: string }) => health.mode && setMode({ ...health.mode, tts: health.tts }))
      .catch(() => {});
  }, []);
  return mode;
}

const RING_LABEL: Record<DeviceState, string> = {
  connecting: "Waking up",
  idle: "Ready",
  listening: "Listening",
  thinking: "Writing the next scene",
  speaking: "Narrating",
  error: "Something went wrong",
};

/**
 * An Echo with no screen: the light ring shows what it's doing, and captions stand in for
 * the narration (a real speaker has none; they're here so the demo can be followed silently).
 */
function SpeakerDevice({ state, heard, spoken }: { state: DeviceState; heard: string; spoken: string }) {
  return (
    <div className="speaker-stage" data-state={state}>
      <img className="speaker-art" src="/art/ashford-house.svg" alt="" />
      <div className="speaker" aria-hidden>
        <span className="speaker-ring" />
        <span className="speaker-top" />
        <span className="speaker-body" />
      </div>
      <div className="speaker-captions">
        <span className="eyebrow">{RING_LABEL[state]}</span>
        {heard && (state === "listening" || state === "thinking") ? (
          <p className="speaker-heard">
            <span>You said</span>“{heard}”
          </p>
        ) : spoken ? (
          <p className="speaker-spoken" aria-live="polite">
            {spoken}
          </p>
        ) : (
          <p className="speaker-hint">
            Say <em>“Tell me a ghost story”</em>, or tap the mic. No screen: just a voice in the dark.
          </p>
        )}
      </div>
    </div>
  );
}

function ScreenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path fill="currentColor" d="M3 5h18v11H3V5zm2 2v7h14V7H5zm4 11h6v2H9v-2z" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path fill="currentColor" d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h10V6H7zm5 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden>
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
      />
    </svg>
  );
}
