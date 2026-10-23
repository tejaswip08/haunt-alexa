import { StoryNotFoundError, storiesOwnedBy, type Story } from "@firetales/core";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { userOf } from "./auth.ts";
import { config } from "./config.ts";
import { forgetGuestKey, guestKeyHash } from "./guest.ts";
import { StoryConflictError } from "@firetales/core/dynamodb";
import { ownedStory } from "./ownership.ts";
import { engine } from "./stories.ts";

/**
 * A signed-in listener's own stories: list them, resume them (through resume_story) and
 * submit finished ones for the library. Every route needs a user, except listing: guests get
 * their own stories from GET /stories too, recognised by the guest-key cookie (see guest.ts).
 * Other people's stories don't exist as far as these routes are concerned.
 */
export const meRouter = Router();

/** The one route a guest may use: listing their own stories. */
const guestListing = (req: Request) => req.method === "GET" && req.path === "/stories";

meRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (!userOf(res) && !guestListing(req)) return void res.status(401).json({ error: "Sign in to see your stories." });
  next();
});

/** What a listener sees about their story. Never other users' data or internal fields. */
export function myStoryView(story: Story) {
  return {
    storyId: story.id,
    title: story.title || "Untitled",
    premise: story.config.premise,
    status: story.status,
    scenes: story.scenes.length,
    targetScenes: story.config.targetScenes,
    lastQuestion: story.status === "active" ? (story.scenes.at(-1)?.question?.prompt ?? null) : null,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    review: story.review
      ? {
          status: story.review.status,
          creator: story.review.creator,
          summary: story.review.summary,
          submittedAt: story.review.submittedAt,
          decidedAt: story.review.decidedAt ?? null,
          reason: story.review.status === "rejected" ? (story.review.reason ?? null) : null,
        }
      : null,
  };
}

/**
 * Signed in: the account's stories. Guest: the stories this device started, found by its
 * guest-key cookie, which only that device has (no cookie, no stories). Holding the cookie
 * already lets a guest resume each of these stories, so listing them reveals nothing new.
 */
meRouter.get("/stories", async (req, res) => {
  const user = userOf(res);
  const stories = user
    ? await storiesOwnedBy(engine.store, user.sub)
    : (await guestStories(req)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ stories: stories.map(myStoryView) });
});

/** This browser's guest stories that could move into the account (see guest.ts). */
async function guestStories(req: Request) {
  return storiesWithGuestKey(guestKeyHash(req));
}

async function storiesWithGuestKey(hash: string | undefined): Promise<Story[]> {
  if (!hash) return [];
  return (await engine.store.list()).filter((story) => !story.ownerId && story.guestKeyHash === hash);
}

/**
 * The same list as GET /stories, for MCP (list_my_stories, get_home): the account's stories when signed in, otherwise the
 * stories that carry this caller's guest key (a browser's cookie, or an external client's token hash). Newest first.
 */
export async function storiesFor(user: { sub: string } | undefined, guestKey: string | undefined): Promise<Story[]> {
  if (user) return storiesOwnedBy(engine.store, user.sub);
  return (await storiesWithGuestKey(guestKey)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

meRouter.get("/guest-stories", async (req, res) => {
  const stories = await guestStories(req);
  res.json({ count: stories.length, stories: stories.map((story) => ({ storyId: story.id, title: story.title || "Untitled" })) });
});

/**
 * Moves this browser's guest stories into the signed-in account, once. Needs the guest-key
 * cookie, which only this browser has; story ids alone claim nothing.
 */
meRouter.post("/claim-guest-stories", async (req, res) => {
  const sub = userOf(res)!.sub;
  let claimed = 0;
  const stories = await guestStories(req);
  for (const story of stories) {
    story.ownerId = sub;
    delete story.guestKeyHash;
    try {
      await engine.store.put(story);
      claimed++;
    } catch (error) {
      // Being played right now somewhere else: it stays a guest story and can be claimed later.
      if (!(error instanceof StoryConflictError)) throw error;
    }
  }
  // Keep the key while any story is left behind, so a later claim can still find it.
  if (claimed === stories.length) forgetGuestKey(res, config.production);
  res.json({ ok: true, claimed, remaining: stories.length - claimed });
});

const SubmitSchema = z.object({
  creator: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(280),
});

/**
 * Ask for a finished story to go in the library. Resubmitting while it waits updates the pen
 * name and summary; a rejected story can be submitted again; an approved one is already in.
 */
meRouter.post("/stories/:storyId/submit", async (req, res) => {
  const parsed = SubmitSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: z.prettifyError(parsed.error) });
  try {
    const story = await ownedStory(String(req.params.storyId), userOf(res));
    // Stories from before sign-in have no owner and can't be claimed this way.
    if (!story.ownerId) throw new StoryNotFoundError(story.id);
    if (story.status !== "completed") {
      return void res.status(409).json({ error: "Finish the story before submitting it." });
    }
    if (story.review?.status === "approved") {
      return void res.status(409).json({ error: "This story is already in the library." });
    }
    const action = story.review?.status === "submitted" ? "updated" : "submitted";
    story.review = { status: "submitted", ...parsed.data, submittedAt: new Date().toISOString() };
    await engine.store.put(story);
    res.json({ ok: true, action, story: myStoryView(story) });
  } catch (error) {
    if (error instanceof StoryNotFoundError) return void res.status(404).json({ error: "No such story." });
    if (error instanceof StoryConflictError) return void res.status(409).json({ error: error.message });
    throw error;
  }
});
