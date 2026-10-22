import { pickSceneArt, type SceneArtId } from "./images.ts";
import type { Mood } from "./types.ts";

/**
 * How a scene should look and move on screen. This is presentation metadata chosen
 * from a fixed allowlist, never instructions: anything a model suggests that isn't on
 * the list is dropped, and clients validate it again before drawing anything.
 */
export const SCENE_EFFECTS = [
  "ambient_fog",
  "flickering_light",
  "shadow_appears",
  "door_opens",
  "camera_shake",
  "cinematic_zoom",
  "scene_fade",
] as const;
export type SceneEffect = (typeof SCENE_EFFECTS)[number];

export type EffectIntensity = "low" | "medium" | "high";

export interface ScenePresentation {
  /** Which illustration and setting-specific motion to use. */
  setting: SceneArtId;
  effects: SceneEffect[];
  intensity: EffectIntensity;
}

export interface PresentationInput {
  mood: Mood;
  visualPrompt: string;
  narration: string;
  soundCues?: string[];
  /** What the listener's last choice meant, e.g. "They ran from the train." */
  decisionOutcome?: string;
  /** Effects a model suggested. Untrusted: filtered against SCENE_EFFECTS. */
  requested?: unknown;
}

const MAX_EFFECTS = 5;
const ALLOWED = new Set<string>(SCENE_EFFECTS);

/** Keeps only known effect names, without duplicates, in a stable order. */
export function sanitizeEffects(value: unknown): SceneEffect[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()));
  return SCENE_EFFECTS.filter((effect) => wanted.has(effect) && ALLOWED.has(effect));
}

const FOG = /fog|mist|smoke|haze|steam|vapou?r|breath (hung|clouded)/i;
const LIGHT = /flicker|lamp|lantern|candle|bulb|fluorescent|neon|light(s)? (dim|die|buzz|stutter|fail)|sputter/i;
const SHADOW = /shadow|silhouette|figure|someone|something (moves|watch)|watching|eyes in the dark/i;
const DOOR = /(door|gate|hatch|lid|curtain)s?\b[^.]{0,40}\b(open|opens|opened|creak|swing|swings|ajar|unlock|gives way)/i;
const VIOLENT = /\b(run|ran|running|sprint|flee|fled|slam|slams|crash|lurch|lurches|shake|shakes|shook|roar|bang|scream|collapse|fall|fell|derail|explod)/i;

const FOGGY_SETTINGS = new Set<SceneArtId>(["forest", "water", "train", "lighthouse"]);
const FLICKER_SETTINGS = new Set<SceneArtId>(["hospital", "train", "house", "door"]);

/**
 * Chooses a scene's presentation from what the scene already says: setting from the image
 * prompt, effects from mood, narration, sound cues and the listener's last choice. The same
 * input always gives the same output, so it is cheap to compute on every request.
 */
export function selectPresentation(input: PresentationInput): ScenePresentation {
  const setting = pickSceneArt(input.visualPrompt || input.narration, input.mood);
  const text = [input.narration, input.visualPrompt, ...(input.soundCues ?? []), input.decisionOutcome ?? ""].join(" ");
  const tense = input.mood === "threat" || input.mood === "suspense";

  const chosen = new Set<SceneEffect>(["scene_fade", "cinematic_zoom"]);
  if (FOGGY_SETTINGS.has(setting) || FOG.test(text)) chosen.add("ambient_fog");
  const quiet = input.mood === "calm" || input.mood === "ending";
  if ((FLICKER_SETTINGS.has(setting) && !quiet) || LIGHT.test(text)) chosen.add("flickering_light");
  if (SHADOW.test(text) || input.mood === "threat") chosen.add("shadow_appears");
  if (DOOR.test(text)) chosen.add("door_opens");
  if (input.mood === "threat" && VIOLENT.test(text)) chosen.add("camera_shake");
  for (const effect of sanitizeEffects(input.requested)) chosen.add(effect);

  // Calm, gentle moments never shake, whatever was requested.
  if (!tense) chosen.delete("camera_shake");
  // An ending lingers: no shake, no sudden shadow.
  if (input.mood === "ending") chosen.delete("shadow_appears");

  const effects = SCENE_EFFECTS.filter((effect) => chosen.has(effect));
  // Over the cap, drop the least essential effects first (zoom, then fog).
  for (const optional of ["cinematic_zoom", "ambient_fog"] as const) {
    const at = effects.indexOf(optional);
    if (effects.length > MAX_EFFECTS && at !== -1) effects.splice(at, 1);
  }

  const intensity: EffectIntensity =
    input.mood === "threat" ? "high" : input.mood === "calm" || input.mood === "ending" ? "low" : "medium";
  return { setting, effects: effects.slice(0, MAX_EFFECTS), intensity };
}

/** The safe default for a scene with nothing to go on. */
export const DEFAULT_PRESENTATION: ScenePresentation = {
  setting: "house",
  effects: ["cinematic_zoom", "scene_fade"],
  intensity: "low",
};
