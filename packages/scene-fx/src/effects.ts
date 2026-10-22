import { SETTINGS, type Setting } from "./art.ts";

/**
 * The effects a client is willing to draw. Mirrors SCENE_EFFECTS in @firetales/core
 * (a test keeps the two in step). Data arriving from the server is checked against it
 * again, so a bad or hostile payload can only ever fall back to the defaults.
 */
export const EFFECTS = [
  "ambient_fog",
  "flickering_light",
  "shadow_appears",
  "door_opens",
  "camera_shake",
  "cinematic_zoom",
  "scene_fade",
] as const;
export type Effect = (typeof EFFECTS)[number];
export type Intensity = "low" | "medium" | "high";

export interface Presentation {
  setting: Setting;
  effects: Effect[];
  intensity: Intensity;
}

export const DEFAULT_PRESENTATION: Presentation = {
  setting: "house",
  effects: ["cinematic_zoom", "scene_fade"],
  intensity: "low",
};

const MOOD_DEFAULT: Record<string, Partial<Presentation>> = {
  threat: { setting: "figure", intensity: "high" },
  suspense: { setting: "door", intensity: "medium" },
  exploration: { setting: "forest", intensity: "medium" },
};

/** Turns whatever arrived into a safe presentation. Unknown settings or effects are ignored. */
export function sanitizePresentation(value: unknown, mood?: string): Presentation {
  const fallback = { ...DEFAULT_PRESENTATION, ...(mood ? MOOD_DEFAULT[mood] : undefined) };
  if (!value || typeof value !== "object") return fallback;
  const raw = value as { setting?: unknown; effects?: unknown; intensity?: unknown };
  const setting = (SETTINGS as readonly unknown[]).includes(raw.setting) ? (raw.setting as Setting) : fallback.setting;
  const wanted = new Set(Array.isArray(raw.effects) ? raw.effects.filter((e): e is string => typeof e === "string") : []);
  const known = EFFECTS.filter((effect) => wanted.has(effect));
  const effects = known.length ? known : fallback.effects;
  const intensity = raw.intensity === "low" || raw.intensity === "medium" || raw.intensity === "high" ? raw.intensity : fallback.intensity;
  return { setting, effects: effects.slice(0, 5), intensity };
}

/** What the viewer chose. "auto" follows the system's reduced-motion setting and the device's speed. */
export type MotionPreference = "auto" | "full" | "reduced" | "off";
/** What actually plays. "reduced" keeps gentle fades and still fog; "off" is a static picture. */
export type MotionLevel = "full" | "reduced" | "off";

export function resolveMotion(preference: MotionPreference, prefersReducedMotion: boolean, slowDevice: boolean): MotionLevel {
  if (preference !== "auto") return preference;
  if (prefersReducedMotion || slowDevice) return "reduced";
  return "full";
}

const STORAGE_KEY = "haunt.motion";

/** The viewer's saved choice. Storage can be missing or blocked, so this never throws. */
export function loadMotionPreference(): MotionPreference {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (value === "full" || value === "reduced" || value === "off" || value === "auto") return value;
  } catch {
    // Private mode or blocked storage: use the default.
  }
  return "auto";
}

export function saveMotionPreference(preference: MotionPreference) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, preference);
  } catch {
    // Not saved; the choice still applies until the page closes.
  }
}

/**
 * Measures the frame rate for about half a second. Below ~30 fps (common on older
 * TV sticks under load) animations step down to "reduced" automatically.
 */
export function probeSlowDevice(frames = 30): Promise<boolean> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve(false);
  return new Promise((resolve) => {
    let count = 0;
    let start = 0;
    const tick = (now: number) => {
      if (count === 0) start = now;
      if (++count < frames) return void requestAnimationFrame(tick);
      const average = (now - start) / (frames - 1);
      resolve(average > 34);
    };
    requestAnimationFrame(tick);
  });
}
