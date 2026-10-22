import { useEffect, useState } from "react";
import type { EpisodePlayback, ListenPlayback, PlayMode, PlayModeRequest } from "../lib/device.ts";
import { LISTEN_MS_PER_CHAR } from "../lib/play-mode.ts";
import { artForStoryId } from "../lib/story-art.ts";

/**
 * The Echo Show screens around playing a story: "How do you want to play?" before every story (like the Fire TV app),
 * and the player for a library episode, which stops at each choice point when playing with choices.
 */

const KIND_LABEL: Record<PlayModeRequest["kind"], string> = {
  episode: "Community story",
  new: "New story",
  continue: "Continue your story",
};

export function PlayModeScreen({ request, onChoose }: { request: PlayModeRequest; onChoose: (mode: PlayMode | null) => void }) {
  return (
    <div className="pm" role="dialog" aria-modal="true" aria-label="How do you want to play?">
      <div className="pm-fog" aria-hidden />
      <div className="pm-content">
        <span className="pm-eyebrow">{KIND_LABEL[request.kind]}</span>
        <h2 className="pm-title">{request.title}</h2>
        {request.detail && <p className="pm-detail">{request.detail}</p>}
        <h3 className="pm-question">How do you want to play?</h3>
        <div className="pm-options">
          <button type="button" className="pm-option" onClick={() => onChoose("choices")} autoFocus>
            <BranchIcon />
            <strong>Play with choices</strong>
            <span>The story stops and you decide what happens next.</span>
          </button>
          <button type="button" className="pm-option" onClick={() => onChoose("listen")}>
            <ListenIcon />
            <strong>Just listen</strong>
            <span>Sit back. It plays straight through to the end.</span>
          </button>
        </div>
        <p className="pm-hint">Say “with choices” or “just listen”</p>
        <button type="button" className="pm-back" onClick={() => onChoose(null)}>
          Back
        </button>
      </div>
    </div>
  );
}

export function EpisodeScreen({
  playback,
  onChoose,
  onReplay,
  onHome,
}: {
  playback: EpisodePlayback;
  onChoose: (option: number) => void;
  onReplay: () => void;
  onHome: () => void;
}) {
  const segment = playback.segments[playback.at];
  const step = playback.played.length;
  return (
    <div className="ep" data-mood={segment?.mood}>
      <img className="ep-art" src={artForStoryId(playback.storyId)} alt="" />
      <div className="ep-shade" aria-hidden />
      <header className="ep-head">
        <div>
          <h2 className="ep-title">{playback.title}</h2>
          <span className="ep-meta">
            by {playback.creator} · {playback.mode === "choices" ? "With choices" : "Just listening"}
          </span>
        </div>
        <button type="button" className="ep-home" onClick={onHome}>
          Home
        </button>
      </header>

      <div className="ep-body">
        {step > 0 && <span className="ep-part">Part {step}</span>}
        {segment && (
          <p className="ep-narration" key={playback.at}>
            {segment.narration}
          </p>
        )}
      </div>

      {playback.choices && (
        <footer className="ep-choices" aria-live="polite">
          <span className="ep-label">What do you do?</span>
          <h3 className="ep-prompt">{playback.choices.prompt}</h3>
          <div className="ep-options">
            {playback.choices.options.map((option, index) => (
              <button key={option.label} type="button" className="ep-option" onClick={() => onChoose(index)} autoFocus={index === 0}>
                <span className="ep-num">{index + 1}</span>
                {option.label}
              </button>
            ))}
          </div>
          <span className="ep-hint">Tap, or say “{playback.choices.options.length > 1 ? "one” or “two" : "one"}”</span>
        </footer>
      )}

      {playback.ended && (
        <footer className="ep-end">
          <span className="ep-label">The end</span>
          <div className="ep-options">
            <button type="button" className="ep-option" onClick={onReplay} autoFocus>
              Play again
            </button>
            <button type="button" className="ep-option" onClick={onHome}>
              Back to Home
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

function formatTime(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * "Just listen": the story plays like a film. The text lights up as it's read, and the timeline has one chapter per
 * part (parts still being written are dashed). Tap a chapter to jump, pause and resume in place, or skip parts.
 */
export function ListenScreen({
  playback,
  onTogglePause,
  onPrevious,
  onNext,
  onJump,
  onHome,
}: {
  playback: ListenPlayback;
  onTogglePause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onJump: (part: number) => void;
  onHome: () => void;
}) {
  // Re-render while playing so the text and timeline move.
  const [, tick] = useState(0);
  const playing = playback.playingSince !== null && !playback.paused;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, [playing]);

  const { parts, at, offset } = playback;
  const part = parts[Math.min(at, parts.length - 1)];
  const partMs = (text: string) => text.length * LISTEN_MS_PER_CHAR;
  const playedInPart = playback.playedMs + (playback.playingSince ? Date.now() - playback.playingSince : 0);
  const currentMs = part ? partMs(part.narration) : 1;
  // Never shows a part as finished before the voice actually finishes it.
  const partProgress = playback.ended ? 1 : at >= parts.length ? 0 : Math.min(0.98, playedInPart / currentMs);
  const revealed = part ? Math.floor(part.narration.length * (playback.ended ? 1 : partProgress)) : 0;

  const writtenMs = parts.reduce((sum, p) => sum + partMs(p.narration), 0);
  const average = parts.length ? writtenMs / parts.length : 0;
  // Timeline positions count the parts heard before this session (offset), so a continued story shows where it is.
  const totalParts = Math.max(playback.total, offset + parts.length);
  const totalMs = writtenMs + Math.max(0, totalParts - parts.length) * average;
  const elapsedMs =
    offset * average +
    parts.slice(0, Math.min(at, parts.length)).reduce((sum, p) => sum + partMs(p.narration), 0) +
    partProgress * (at < parts.length ? currentMs : 0);
  const position = offset + at;

  const status = playback.ended
    ? "The end"
    : playback.writing
      ? "Writing the next part…"
      : playback.paused
        ? "Paused"
        : `Part ${Math.min(position + 1, totalParts)} of ${totalParts}`;

  return (
    <div className={`ls${playback.paused ? " is-paused" : ""}`}>
      <img className="ep-art ls-art" src={artForStoryId(playback.storyId)} alt="" />
      <div className="ep-shade" aria-hidden />
      <header className="ep-head">
        <div>
          <h2 className="ep-title">{playback.title}</h2>
          <span className="ep-meta">
            {playback.creator ? `by ${playback.creator} · ` : ""}Just listening
          </span>
        </div>
        <button type="button" className="ep-home" onClick={onHome}>
          Home
        </button>
      </header>

      <div className="ep-body ls-body">
        {playback.writing && !playback.ended ? (
          <div className="ls-writing" role="status">
            <span className="forge-flame" aria-hidden />
            <span>Writing what happens next…</span>
          </div>
        ) : (
          part && (
            <p className="ep-narration ls-narration" key={at}>
              <span className="ls-read">{part.narration.slice(0, revealed)}</span>
              <span className="ls-unread">{part.narration.slice(revealed)}</span>
            </p>
          )
        )}
      </div>

      <footer className="ls-controls">
        <div className="ls-timeline" role="group" aria-label="Story timeline">
          {Array.from({ length: totalParts }, (_, i) => {
            const fill = i < position || playback.ended ? 1 : i === position ? partProgress : 0;
            const part = i - offset;
            const heardBefore = part < 0;
            const written = heardBefore || part < parts.length;
            const canJump = !heardBefore && (part < parts.length || (part === parts.length && !playback.ended));
            return (
              <button
                key={i}
                type="button"
                className={`ls-chapter${written ? "" : " is-unwritten"}${i === position && !playback.ended ? " is-current" : ""}`}
                onClick={() => canJump && onJump(part)}
                disabled={!canJump}
                aria-label={`Part ${i + 1}${written ? "" : " (not written yet)"}`}
              >
                <span className="ls-fill" style={{ width: `${fill * 100}%` }} />
              </button>
            );
          })}
        </div>
        <div className="ls-row">
          <span className="ls-time">
            {formatTime(elapsedMs)} / {totalParts > parts.length ? "~" : ""}
            {formatTime(totalMs)}
          </span>
          <div className="ls-buttons">
            <button type="button" className="ls-btn" onClick={onPrevious} aria-label="Previous part">
              <svg viewBox="0 0 24 24" aria-hidden><path d="M6 5h2v14H6zM20 5v14L9 12z" fill="currentColor" /></svg>
            </button>
            <button type="button" className="ls-btn ls-play" onClick={onTogglePause} aria-label={playback.paused || playback.ended ? "Play" : "Pause"} disabled={playback.ended}>
              {playback.paused ? (
                <svg viewBox="0 0 24 24" aria-hidden><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>
              )}
            </button>
            <button type="button" className="ls-btn" onClick={onNext} aria-label="Next part" disabled={playback.ended}>
              <svg viewBox="0 0 24 24" aria-hidden><path d="M16 5h2v14h-2zM4 5v14l11-7z" fill="currentColor" /></svg>
            </button>
          </div>
          <span className="ls-status">{status}</span>
        </div>
        {playback.ended ? (
          <div className="ls-end">
            <button type="button" className="ep-option" onClick={() => onJump(0)} autoFocus>
              Play again
            </button>
            <button type="button" className="ep-option" onClick={onHome}>
              Back to Home
            </button>
          </div>
        ) : (
          <span className="ls-hint">Say “pause”, “resume”, “next” or “start over”</span>
        )}
      </footer>
    </div>
  );
}

function BranchIcon() {
  return (
    <svg className="pm-icon" viewBox="0 0 24 24" aria-hidden>
      <path d="M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6M6 9a6 6 0 0 1 6 6M18 3v6a6 6 0 0 1-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="6" cy="3" r="1.6" fill="currentColor" />
      <circle cx="18" cy="3" r="1.6" fill="currentColor" />
    </svg>
  );
}

function ListenIcon() {
  return (
    <svg className="pm-icon" viewBox="0 0 24 24" aria-hidden>
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <rect x="3" y="14" width="4.5" height="7" rx="1.6" fill="currentColor" />
      <rect x="16.5" y="14" width="4.5" height="7" rx="1.6" fill="currentColor" />
    </svg>
  );
}
