/**
 * How a story plays on the simulated Echo Show, asked before every story like the Fire TV app does:
 * "choices" stops where the story branches and lets the listener decide; "listen" plays straight through.
 * Also the voice parsing for that question and for picking an option, and how a published episode branches.
 */

export type PlayMode = "choices" | "listen";

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please |ok |okay |alexa |hey |um |uh )+/, "")
    .replace(/( please| now)$/, "");
}

const LISTEN = /^(?:i(?:'ll| will)? )?(?:just |only )?(?:listen|listening)(?: to it)?$|^(?:just listen|sit back|no choices|without choices|play it straight through|straight through|read it to me|just play it|just play|two|second(?: one)?|option two|the second one)$/;
const CHOICES = /^(?:play )?(?:with )?(?:the )?choices$|^(?:interactive|let me choose|i(?:'ll| will)? choose|i want to choose|choose|play with choices|with choices|one|first(?: one)?|option one|the first one)$/;

/** "with choices" / "just listen" (or "one" / "two", the buttons' order) → a mode; anything else → null. */
export function parsePlayMode(spoken: string): PlayMode | null {
  const text = clean(spoken);
  if (!text) return null;
  if (LISTEN.test(text)) return "listen";
  if (CHOICES.test(text)) return "choices";
  return null;
}

/** "cancel", "go back", "never mind" while the question is open. */
export function isCancel(spoken: string): boolean {
  return /^(?:cancel|stop|never mind|nevermind|go back|back|not now|no thanks)$/.test(clean(spoken));
}

const POSITIONS: Record<string, number> = {
  one: 0, first: 0, "1": 0, "1st": 0,
  two: 1, second: 1, "2": 1, "2nd": 1,
  three: 2, third: 2, "3": 2, "3rd": 2,
  four: 3, fourth: 3, "4": 3, "4th": 3,
};
const SMALL = new Set(["the", "a", "an", "to", "i", "and", "of", "it", "my", "go", "in", "on", "at", "for", "with"]);

/** Which option the listener picked: "two", "the second one", "option 1", or words from its label. */
export function pickOption(spoken: string, labels: readonly string[]): number | null {
  const text = clean(spoken).replace(/^(?:i pick |i choose |i'll |i will |let's |lets |choose |pick |option |number )+/, "").replace(/ (?:one|option)$/, "");
  if (!text) return null;
  const position = POSITIONS[text.replace(/^the /, "")];
  if (position !== undefined && position < labels.length) return position;

  const said = new Set(text.split(" ").filter((word) => !SMALL.has(word)));
  let best: { index: number; score: number } | null = null;
  labels.forEach((label, index) => {
    const words = clean(label).split(" ").filter((word) => !SMALL.has(word));
    if (clean(label) === text) best = { index, score: Infinity };
    const score = words.filter((word) => said.has(word)).length;
    if (score > 0 && (!best || score > best.score)) best = { index, score };
  });
  return (best as { index: number } | null)?.index ?? null;
}

export interface EpisodeSegmentLike {
  choices?: { prompt: string; options: { label: string; next: number }[] };
  next?: number;
  ending?: boolean;
}

/** Where an episode goes after segment `at` (with the chosen option at a choice point). Same rule as the server's mainPath. */
export function nextSegment(segments: readonly EpisodeSegmentLike[], at: number, option = 0): number | undefined {
  const segment = segments[at];
  if (!segment || segment.ending) return undefined;
  const next = segment.choices ? segment.choices.options[option]?.next : (segment.next ?? at + 1);
  return next !== undefined && next < segments.length ? next : undefined;
}

export type ListenControl = "pause" | "resume" | "next" | "previous" | "restart";

/** Spoken controls for the "just listen" player: "pause", "resume", "next part", "previous", "start over". */
export function parseListenControl(spoken: string): ListenControl | null {
  const text = clean(spoken).replace(/ (?:the )?story$/, "").replace(/ it$/, "");
  if (/^(?:pause|hold on|wait|hold|freeze)$/.test(text)) return "pause";
  if (/^(?:resume|play|continue|keep going|go on|carry on|unpause|keep playing)$/.test(text)) return "resume";
  if (/^(?:next|skip|next part|skip ahead|skip this part|forward|fast forward|next chapter)$/.test(text)) return "next";
  if (/^(?:previous|previous part|rewind|back a part|go back a part|last part|previous chapter|replay this part)$/.test(text)) return "previous";
  if (/^(?:start over|from the beginning|restart|play again|again from the start)$/.test(text)) return "restart";
  return null;
}

/** Reading speed the timeline assumes, as on the Fire TV listen player (apps/tv story/engine.ts). */
export const LISTEN_MS_PER_CHAR = 60;
