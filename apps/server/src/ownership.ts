import { StoryNotFoundError, type Story } from "@firetales/core";
import type { User } from "./auth.ts";
import { engine } from "./stories.ts";

/**
 * A story the caller may read or continue. Someone else's story looks exactly like a missing
 * one, so ids can't be probed.
 *
 * - An account's story: only that signed-in user.
 * - A guest's story: only the browser holding its guest key.
 * - Older stories, and stories from external MCP clients, have neither and stay open to
 *   whoever holds their id, as before.
 */
export async function ownedStory(storyId: string, user: User | undefined, guestKeyHash?: string): Promise<Story> {
  const story = await engine.get(storyId);
  if (!mayUse(story, user, guestKeyHash)) throw new StoryNotFoundError(storyId);
  return story;
}

export function mayUse(story: Story, user: User | undefined, guestKeyHash?: string): boolean {
  if (story.ownerId) return story.ownerId === user?.sub;
  if (story.guestKeyHash) return story.guestKeyHash === guestKeyHash;
  return true;
}

/**
 * For changes (answering, finishing). Stricter than `ownedStory`: a story with no owner and no guest key
 * (one from before sign-in) can be read, but nobody can change it. A signed-in account changes only its own
 * stories; the guest device changes only its own guest stories.
 */
export async function writableStory(storyId: string, user: User | undefined, guestKeyHash?: string): Promise<Story> {
  const story = await engine.get(storyId);
  const allowed = story.ownerId
    ? story.ownerId === user?.sub
    : Boolean(story.guestKeyHash) && story.guestKeyHash === guestKeyHash;
  if (!allowed) throw new StoryNotFoundError(storyId);
  return story;
}
