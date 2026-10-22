import type { EpisodePlayback, PlayMode, PlayModeRequest } from "../lib/device.ts";
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
