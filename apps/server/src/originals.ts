import { Router } from "express";
import { engagement, type Counts } from "./engagement.ts";
import { library, type LibraryEntry } from "./stories.ts";

/**
 * Public, read-only access to the Haunt Original stories: the team's published originals,
 * readable by guests and signed-in listeners alike. Only entries marked HAUNT_ORIGINAL are
 * returned. Community submissions, pending or rejected stories, and admin data never appear here.
 *
 *   GET /api/originals          the list, newest first
 *   GET /api/originals/:storyId one story's details (no narration: play it through play_episode)
 */

export const HAUNT_ORIGINAL = "HAUNT_ORIGINAL";

export const isHauntOriginal = (entry: LibraryEntry | undefined): entry is LibraryEntry =>
  entry?.source === HAUNT_ORIGINAL;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The live totals for one story, or null when the database isn't available (the card then shows no count). */
async function countsOf(storyId: string): Promise<Counts | null> {
  if (!engagement) return null;
  try {
    return await engagement.counts(storyId);
  } catch (error) {
    console.error("[originals] counts failed:", (error as Error).name);
    return null;
  }
}

/** What anyone may see about an original. Counts are the live totals (engagement.ts), or null when unavailable. */
function card(entry: LibraryEntry, counts: Counts | null) {
  return {
    storyId: entry.episode.storyId,
    title: entry.episode.title,
    summary: entry.summary,
    creator: entry.creator,
    genre: entry.genre ?? "Horror",
    subgenre: entry.subgenre ?? null,
    minutes: entry.episode.estimatedMinutes,
    publishedAt: entry.publishedAt,
    likes: counts?.likes ?? null,
    plays: counts?.plays ?? null,
  };
}

export const originalsRouter = Router();

originalsRouter.get("/", async (_req, res) => {
  const originals = (await library.list()).filter(isHauntOriginal);
  const cards = await Promise.all(originals.map(async (entry) => card(entry, await countsOf(entry.episode.storyId))));
  res.json({ originals: cards });
});

originalsRouter.get("/:storyId", async (req, res) => {
  const storyId = String(req.params.storyId);
  if (!SAFE_ID.test(storyId)) return void res.status(404).json({ error: "No such story." });
  const entry = await library.get(storyId);
  // Anything that isn't a published original looks exactly like a missing story.
  if (!isHauntOriginal(entry)) return void res.status(404).json({ error: "No such story." });
  res.json({ original: { ...card(entry, await countsOf(storyId)), premise: entry.episode.premise, ending: entry.ending ?? null } });
});
