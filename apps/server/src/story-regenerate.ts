// Regenerates a My Stories story from its sub-genre settings. The story engine writes a whole play-through (every scene
// with its question and the suggested answers), which is then saved as the creator's working draft. Nothing here makes
// a story public: the draft goes to review like any other edit, and the approved copy stays live until an admin approves.
import { SUBGENRE_IDS, type StoryEngine, type Story, type SubgenreId } from "@firetales/core";
import type { StoryInput } from "./user-stories.ts";
import { z } from "zod";

export const SETTINGS_LENGTH = { short: 4, standard: 6, epic: 8 } as const;

export const StorySettingsSchema = z.object({
  subgenre: z.enum(SUBGENRE_IDS),
  length: z.enum(["short", "standard", "epic"]),
  fear: z.enum(["eerie", "scary", "terrifying"]),
  language: z.string().trim().min(2).max(16),
  idea: z.string().trim().max(200).default(""),
});
export type StorySettings = z.infer<typeof StorySettingsSchema>;

export interface GeneratedStory {
  title: string;
  segments: StoryInput["segments"];
}

export type SettingsGenerator = (settings: StorySettings, premise: string) => Promise<GeneratedStory>;

/** Answers each question with its first suggestion, so the play-through runs to its ending. */
const CONTINUE = "Keep going";
const LABEL_MAX = 120;

export function createSettingsGenerator(engine: StoryEngine): SettingsGenerator {
  return async (settings, premise) => {
    const targetScenes = SETTINGS_LENGTH[settings.length];
    // No owner on this play-through: it is only a source for the draft, and it never appears in anyone's listing.
    let turn = await engine.start({ premise, subgenre: settings.subgenre as SubgenreId, intensity: settings.fear, language: settings.language, targetScenes });
    for (let guard = targetScenes + 2; turn.story.status === "active" && guard > 0; guard--) {
      const question = turn.story.scenes.at(-1)?.question;
      turn = await engine.decide(turn.story.id, question?.suggestions[0]?.slice(0, 500) || CONTINUE);
    }
    if (turn.story.status !== "completed") throw new GenerationError("The story didn't reach an ending. Try again.");
    return { title: turn.story.title || "Untitled story", segments: segmentsOf(turn.story) };
  };
}

export class GenerationError extends Error {
  readonly name = "GenerationError";
}

/** The play-through as editable scenes: each question becomes the choice, and its suggestions lead to the next scene. */
export function segmentsOf(story: Story): StoryInput["segments"] {
  const last = story.scenes.length - 1;
  return story.scenes.map((scene, index) => {
    const base = {
      sceneIndex: index,
      narration: scene.narration.trim(),
      mood: scene.mood,
      soundCues: scene.soundCues.slice(0, 8),
      visualPrompt: scene.visualPrompt.slice(0, 400),
    };
    if (index === last) return { ...base, ending: true };
    const options = (scene.question?.suggestions ?? []).slice(0, 4).map((label) => ({ label: label.slice(0, LABEL_MAX), next: index + 1 }));
    if (!scene.question || options.length === 0) return { ...base, next: index + 1 };
    return { ...base, choices: { prompt: scene.question.prompt.slice(0, 300), options }, next: index + 1 };
  });
}
