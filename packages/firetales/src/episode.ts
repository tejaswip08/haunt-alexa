import type { Mood, Story } from "./types.ts";

/** A decision at the end of a segment. Each option names the segment it leads to (an index into `segments`). */
export interface EpisodeChoices {
  prompt: string;
  options: { label: string; next: number }[];
}

export interface EpisodeSegment {
  sceneIndex: number;
  narration: string;
  mood: Mood;
  soundCues: string[];
  visualPrompt: string;
  /** Present only where the listener decides what happens next. The first option is the main storyline. */
  choices?: EpisodeChoices;
  /** Where the story goes after this segment when there are no choices. Defaults to the next segment. */
  next?: number;
  /** The story ends here. */
  ending?: boolean;
}

/**
 * The main storyline as segment indexes, in order: from the first segment, always taking the first option of a choice,
 * until an ending. "Listen without choices" plays exactly this path, so a branching story still narrates straight through.
 */
export function mainPath(segments: Pick<EpisodeSegment, "choices" | "next" | "ending">[]): number[] {
  const path: number[] = [];
  const seen = new Set<number>();
  let at: number | undefined = 0;
  while (at !== undefined && at < segments.length && !seen.has(at)) {
    seen.add(at);
    path.push(at);
    const segment: Pick<EpisodeSegment, "choices" | "next" | "ending"> | undefined = segments[at];
    if (!segment || segment.ending) break;
    at = segment.choices ? segment.choices.options[0]?.next : (segment.next ?? at + 1);
  }
  return path;
}

/**
 * A finished story as a listen-through episode: narration only. Questions, the
 * listener's answers and their voice never appear here by construction.
 */
export interface Episode {
  storyId: string;
  title: string;
  premise: string;
  language: string;
  segments: EpisodeSegment[];
  /** Full narration script, scenes separated by blank lines. */
  script: string;
  wordCount: number;
  estimatedMinutes: number;
}

const NARRATION_WORDS_PER_MINUTE = 150;

export function exportEpisode(story: Story): Episode {
  const segments = story.scenes.map((scene) => ({
    sceneIndex: scene.index,
    narration: scene.narration.trim(),
    mood: scene.mood,
    soundCues: scene.soundCues,
    visualPrompt: scene.visualPrompt,
  }));
  const script = segments.map((segment) => segment.narration).join("\n\n");
  const wordCount = script.split(/\s+/).filter(Boolean).length;
  return {
    storyId: story.id,
    title: story.title,
    premise: story.config.premise,
    language: story.config.language,
    segments,
    script,
    wordCount,
    estimatedMinutes: Math.max(1, Math.round(wordCount / NARRATION_WORDS_PER_MINUTE)),
  };
}
