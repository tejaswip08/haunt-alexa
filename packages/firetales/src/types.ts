import { z } from "zod";
import { SUBGENRE_IDS } from "./subgenres.ts";

/** Emotional state of a scene. Drives music, ambience and visual tint. */
export const MoodSchema = z.enum([
  "calm",
  "uneasy",
  "suspense",
  "exploration",
  "threat",
  "revelation",
  "ending",
]);
export type Mood = z.infer<typeof MoodSchema>;

/** Where the story sits in its dramatic arc. */
export const PhaseSchema = z.enum(["opening", "rising_action", "climax", "resolution"]);
export type Phase = z.infer<typeof PhaseSchema>;

export const StoryConfigSchema = z.object({
  premise: z.string().trim().min(1).max(500),
  genre: z.string().trim().min(1).default("supernatural horror"),
  /** The Create screen's sub-genre id (e.g. "ghost", "folk"). Optional: stories started without one stay general. */
  subgenre: z.enum(SUBGENRE_IDS).optional(),
  language: z.string().trim().min(2).default("en"),
  intensity: z.enum(["eerie", "scary", "terrifying"]).default("scary"),
  /** "general" keeps every intensity non-graphic, as voice platforms such as Alexa+ require. */
  audience: z.enum(["all_ages", "general", "mature"]).default("general"),
  /** Total scenes including the ending. Questions are asked after every scene but the last. */
  targetScenes: z.number().int().min(3).max(12).default(6),
});
export type StoryConfigInput = z.input<typeof StoryConfigSchema>;
export type StoryConfig = z.output<typeof StoryConfigSchema>;

export interface Character {
  name: string;
  description: string;
}

/** A question the narrator asks the listener. Part of the interaction log, never the episode. */
export interface DecisionPrompt {
  prompt: string;
  suggestions: string[];
}

export interface Scene {
  index: number;
  /** Canonical story prose. The only text that ends up in an exported episode. */
  narration: string;
  mood: Mood;
  soundCues: string[];
  /** One-sentence description of a single still image for this scene. */
  visualPrompt: string;
  /** On-screen effects the writer suggested, already filtered against SCENE_EFFECTS. */
  effects?: string[];
  /** Asked after the narration. `null` on the final scene. */
  question: DecisionPrompt | null;
  createdAt: string;
}

export interface Decision {
  /** Index of the scene whose question was answered. */
  sceneIndex: number;
  question: string;
  /** The listener's own words. Interaction log only, never exported. */
  answer: string;
  /** What the choice meant in-story, as interpreted by the director. */
  outcome: string;
  at: string;
}

export type StoryStatus = "active" | "completed";

/** Where a finished story is in the library review: the listener submits it, an admin decides. */
export interface StoryReview {
  status: "submitted" | "approved" | "rejected";
  /** Pen name and library summary the listener asked for. */
  creator: string;
  summary: string;
  submittedAt: string;
  decidedAt?: string;
  /** Shown to the listener when a story is rejected. */
  reason?: string;
}

export interface Story {
  id: string;
  title: string;
  config: StoryConfig;
  status: StoryStatus;
  phase: Phase;
  /** One-sentence setting summary: place, era, atmosphere. */
  world: string;
  characters: Character[];
  /** Facts established so far that every later scene must respect. */
  facts: string[];
  scenes: Scene[];
  decisions: Decision[];
  /** Who made the story (e.g. a Cognito user's `sub`). Stories made before sign-in have none. */
  ownerId?: string;
  /** For a guest's story: a hash of that browser's guest key, so only it can continue or claim the story. */
  guestKeyHash?: string;
  review?: StoryReview;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a provider (usually an LLM) writes for one turn. The engine validates it,
 * then folds it into the story state.
 */
export const SceneDraftSchema = z.object({
  title: z.string().describe("Story title, 2-6 words. Invent it on the opening scene, then repeat the existing title."),
  world: z.string().describe("One sentence: place, era and atmosphere. Keep it stable after the opening scene."),
  decisionOutcome: z
    .string()
    .default("")
    .describe(
      "If the listener just answered a question: one third-person sentence describing what their choice meant in the story. Empty string on the opening scene.",
    ),
  narration: z.string().describe("The scene prose that the narrator reads aloud. Never contains the question."),
  mood: MoodSchema,
  soundCues: z.array(z.string()).default([]).describe("2-4 short ambient sound labels, e.g. \"distant train horn\"."),
  visualPrompt: z.string().describe("One sentence describing a single still illustration of this scene."),
  question: z.string().describe("The plot-changing question asked after the narration. Empty string on the final scene."),
  suggestions: z.array(z.string()).default([]).describe("2-3 short example answers (2-6 words each). Empty on the final scene."),
  newFacts: z.array(z.string()).default([]).describe("Facts established in this scene that later scenes must respect."),
  newCharacters: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .default([])
    .describe("Characters appearing for the first time in this scene."),
  phase: PhaseSchema,
  isEnding: z.boolean().describe("True only for the final scene, which resolves the story and asks no question."),
  effects: z
    .array(z.string())
    .max(6)
    .optional()
    .describe(
      "Optional on-screen effects for this scene, chosen only from: ambient_fog, flickering_light, shadow_appears, door_opens, camera_shake, cinematic_zoom, scene_fade. Use camera_shake only for sudden violent moments.",
    ),
});
export type SceneDraft = z.infer<typeof SceneDraftSchema>;

/** How a turn's scene was produced. "prewritten" means a branch written ahead of time was used. */
export type TurnSource = "opening" | "live" | "prewritten";

/** The result of starting a story or advancing it by one decision. */
export interface StoryTurn {
  story: Story;
  scene: Scene;
  source: TurnSource;
}
