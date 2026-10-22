// Ported verbatim from apps/tv/src/story/engine.ts (UI-free story engine).
// A tiny, UI-free story engine for the demo. It is an early sketch of the
// NarrativeKit contract: scenes, choices with consequences, an inventory of
// clues, and endings. Later the scenes will come from the backend (Bedrock)
// instead of a hand-written script, but the player screen won't change.

export type ItemId = string;

export interface Item {
  name: string;
  icon: string;
  description: string;
}

export interface Choice {
  id: string;
  label: string;
  hint?: string;
  next: string; // scene id
  /** Only available if the player holds this item. */
  requires?: ItemId;
}

export type EndingKind = 'escape' | 'trapped' | 'truth' | 'death';

export interface Ending {
  id: string;
  kind: EndingKind;
  title: string;
  epilogue: string;
}

export interface Scene {
  id: string;
  chapter: string;
  location: string;
  art: string;
  narration: string;
  /** A spoken line from a character, shown after the narration. */
  voice?: { speaker: string; line: string };
  /** Item picked up when entering the scene. */
  found?: ItemId;
  choices: Choice[];
  ending?: Ending;
}

export interface StoryScript {
  id: string;
  title: string;
  subtitle: string;
  subgenreName: string;
  start: string;
  items: Record<ItemId, Item>;
  scenes: Record<string, Scene>;
  endingCount: number;
}

export interface PlayState {
  sceneId: string;
  inventory: ItemId[];
  /** Choices made so far, for the ending recap. */
  path: string[];
  /** Item picked up in the current scene, if new. */
  justFound?: ItemId;
}

export function startStory(script: StoryScript): PlayState {
  return enter(script, { sceneId: script.start, inventory: [], path: [] });
}

export function canChoose(state: PlayState, choice: Choice) {
  return !choice.requires || state.inventory.includes(choice.requires);
}

export function choose(script: StoryScript, state: PlayState, choice: Choice): PlayState {
  if (!canChoose(state, choice)) return state;
  return enter(script, { ...state, sceneId: choice.next, path: [...state.path, choice.label] });
}

function enter(script: StoryScript, state: PlayState): PlayState {
  const scene = script.scenes[state.sceneId];
  if (!scene) throw new Error(`Unknown scene "${state.sceneId}" in ${script.id}`);
  const found = scene.found && !state.inventory.includes(scene.found) ? scene.found : undefined;
  return {
    ...state,
    inventory: found ? [...state.inventory, found] : state.inventory,
    justFound: found,
  };
}

export interface ListenSegment {
  scene: Scene;
  /** Item picked up in this scene, if any. */
  found?: ItemId;
  startMs: number;
  /** Time the narration text takes; the voice line and a pause follow. */
  narrationMs: number;
  durationMs: number;
}

// Pace of the (future) narrator voice, used to lay the story out on a timeline.
export const LISTEN_MS_PER_CHAR = 60;
const LISTEN_VOICE_GAP_MS = 800;
const LISTEN_SCENE_HOLD_MS = 2500;

/**
 * "Listen without choices": follow the first open choice in every scene and
 * lay the resulting path out end to end, so it can be played like a video.
 */
export function listenTimeline(script: StoryScript) {
  const segments: ListenSegment[] = [];
  let state = startStory(script);
  let startMs = 0;
  for (let guard = 0; guard < 50; guard++) {
    const scene = script.scenes[state.sceneId];
    const narrationMs = scene.narration.length * LISTEN_MS_PER_CHAR;
    const voiceMs = scene.voice ? LISTEN_VOICE_GAP_MS + scene.voice.line.length * LISTEN_MS_PER_CHAR : 0;
    const durationMs = narrationMs + voiceMs + LISTEN_SCENE_HOLD_MS;
    segments.push({ scene, found: state.justFound, startMs, narrationMs, durationMs });
    startMs += durationMs;
    if (scene.ending) break;
    const next = scene.choices.find((c) => canChoose(state, c));
    if (!next) break;
    state = choose(script, state, next);
  }
  return { segments, totalMs: startMs };
}
