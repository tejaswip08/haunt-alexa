import { useSyncExternalStore } from "react";

/**
 * My Stories on the simulated Echo Show: the real stories started on this device, remembered in this browser.
 * Every entry comes from a story the MCP server actually returned (start_story, answer_story, resume_story),
 * and is continued with resume_story. Nothing here is made up; an empty list means none were started yet.
 */
export interface SavedStory {
  storyId: string;
  title: string;
  sceneNumber: number;
  totalScenes: number;
  status: "active" | "completed";
  updatedAt: number;
}

const KEY = "haunt.alexa.my-stories";
const MAX = 24;
const listeners = new Set<() => void>();
let cache: SavedStory[] | null = null;

function read(): SavedStory[] {
  if (cache) return cache;
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as SavedStory[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: SavedStory[]) {
  cache = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private windows and blocked storage: the list still works until the page reloads.
  }
  listeners.forEach((listener) => listener());
}

/** Newest first. */
export function myStories(): SavedStory[] {
  return read();
}

/** Records (or updates) a story from a scene the server returned. */
export function rememberStory(scene: { storyId: string; title?: string; sceneNumber?: number; totalScenes?: number; status: "active" | "completed" }) {
  if (!scene.storyId) return;
  const earlier = read().find((s) => s.storyId === scene.storyId);
  const entry: SavedStory = {
    storyId: scene.storyId,
    title: scene.title || earlier?.title || "Untitled story",
    sceneNumber: scene.sceneNumber ?? earlier?.sceneNumber ?? 1,
    totalScenes: scene.totalScenes ?? earlier?.totalScenes ?? 6,
    status: scene.status,
    updatedAt: Date.now(),
  };
  write([entry, ...read().filter((s) => s.storyId !== scene.storyId)].slice(0, MAX));
}

export function useMyStories(): SavedStory[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => [],
  );
}
