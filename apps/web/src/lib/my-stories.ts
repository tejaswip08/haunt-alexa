import { useSyncExternalStore } from "react";
import { hasTool, type HauntConnection } from "./mcp.ts";

/**
 * My Stories on the simulated Echo Show. The list comes from the server over MCP (list_my_stories): the account's stories
 * when signed in, or this browser's as a guest. This browser also remembers every story the MCP server returned
 * (start_story, answer_story, resume_story), which is shown while the server list loads, and instead of it on a server
 * that doesn't have list_my_stories yet. Every story is continued with resume_story. Nothing here is made up.
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

/** One of the listener's stories as the server lists it (MCP list_my_stories and get_home). */
export interface ListedStory {
  storyId: string;
  title: string;
  status: string;
  sceneNumber: number;
  totalScenes: number;
  updatedAt: string;
}

export function fromListed(story: ListedStory): SavedStory {
  return {
    storyId: story.storyId,
    title: story.title || "Untitled story",
    sceneNumber: story.sceneNumber,
    totalScenes: story.totalScenes,
    status: story.status === "completed" ? "completed" : "active",
    updatedAt: Date.parse(story.updatedAt) || Date.now(),
  };
}

/**
 * The listener's stories from the server (MCP list_my_stories), newest first. null when the call fails, including on a
 * server without the tool, so the caller can fall back to the list remembered in this browser.
 */
export async function fetchMyStories(connection: Pick<HauntConnection, "call" | "tools">): Promise<SavedStory[] | null> {
  if (!hasTool(connection, "list_my_stories")) return null;
  try {
    const result = await connection.call("list_my_stories", {}).result;
    const data = result.structuredContent as { stories?: ListedStory[] } | undefined;
    if (result.isError || !Array.isArray(data?.stories)) return null;
    return data.stories.map(fromListed);
  } catch {
    return null;
  }
}
