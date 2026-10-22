import { useEffect, useState } from "react";
import { FEAR, LANGUAGES, LENGTHS, SUBGENRES } from "../lib/create-voice.ts";
import type { StartStoryInput } from "../lib/device.ts";

/**
 * Shown on the Echo Show screen while start_story writes the first scene: the chosen sub-genre's art drifting in the
 * dark, a candle-like pulse, what was asked for, and lines that change as the wait goes on. It stays until the scene
 * view has loaded underneath, so the screen never goes blank.
 */

const STEPS = [
  "Listening to the dark…",
  "Choosing where it begins…",
  "Writing the first scene…",
  "Setting the mood…",
  "Finding the right voice…",
  "Almost ready. Don’t look behind you.",
];
const STEP_MS = 2600;

export function StoryForge({ input }: { input: Partial<StartStoryInput> }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), STEP_MS);
    return () => clearInterval(timer);
  }, []);

  const subgenre = SUBGENRES.find((s) => s.id === input.subgenre);
  const details = [
    subgenre?.name,
    FEAR.find((f) => f.id === input.intensity)?.name,
    LENGTHS.find((l) => l.id === input.length)?.name,
    LANGUAGES.find((l) => l.code === input.language)?.label.split(" · ").pop(),
  ].filter(Boolean) as string[];
  const premise = input.premise?.trim();

  return (
    <div className="forge" role="status" aria-live="polite" aria-label="Creating your story">
      {subgenre && <div className="forge-art" style={{ backgroundImage: `url(${subgenre.art})` }} aria-hidden />}
      <div className="forge-fog" aria-hidden />
      <div className="forge-fog forge-fog-2" aria-hidden />

      <div className="forge-content">
        <div className="forge-sigil" aria-hidden>
          <span className="forge-ring" />
          <span className="forge-ring forge-ring-2" />
          <span className="forge-flame" />
        </div>
        <span className="forge-eyebrow">Creating your story</span>
        <h2 className="forge-title">Summoning something in the dark</h2>
        {premise && <p className="forge-premise">“{premise}”</p>}
        {details.length > 0 && (
          <ul className="forge-details">
            {details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
        <p className="forge-step" key={step}>
          {STEPS[step]}
        </p>
        <div className="forge-bar" aria-hidden>
          <span />
        </div>
      </div>
    </div>
  );
}
