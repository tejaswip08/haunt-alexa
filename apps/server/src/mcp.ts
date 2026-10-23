import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  StoryNotFoundError,
  StoryRefusalError,
  StoryStateError,
  SUBGENRE_IDS,
  createLocalArtProvider,
  mainPath,
  selectPresentation,
  type Scene,
  type ScenePresentation,
  type SceneImage,
  type Story,
} from "@firetales/core";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { User } from "./auth.ts";
import { config } from "./config.ts";
import { activeFeatured, dynamoFeaturedStore } from "./featured.ts";
import { uniqueEntries, type LibraryEntry } from "./library.ts";
import { storiesFor } from "./me.ts";
import { ownedStory, writableStory } from "./ownership.ts";
import { dynamo, engine, library } from "./stories.ts";
import { engagement } from "./engagement.ts";

/** Free local illustrations. Replace with an image-model provider once one is approved. */
const sceneImages = createLocalArtProvider();

const LENGTHS = { short: 4, medium: 6, long: 8 } as const;
/** How many of the listener's stories list_my_stories returns, and how many more community stories Home suggests. */
const MY_STORIES_LIMIT = 24;
const HOME_MORE = 5;

export const DELIVERY_META_KEY = "io.haunt/delivery";

const INSTRUCTIONS = `Haunt tells original, interactive horror stories. Start one with start_story, then pass each of the listener's replies to answer_story verbatim. Every scene comes from these tools: never write story content yourself. Present each scene's narration and then its question to the listener as written, without adding commentary. Never read out storyId or other internal fields.`;

/** Status lines a host can show while a scene tool runs and once it has finished. */
const STATUS = {
  start_story: { invoking: "Summoning your story…", invoked: "Your story begins" },
  answer_story: { invoking: "The story is shifting…", invoked: "The story continues" },
  end_story: { invoking: "Writing the ending…", invoked: "The end" },
  resume_story: { invoking: "Finding your place…", invoked: "Back where you left off" },
  play_episode: { invoking: "Finding the episode…", invoked: "Now playing" },
} as const;

type SceneTool = keyof typeof STATUS;

function sceneUiMeta(tool: SceneTool, resourceUri: string) {
  return { ui: { resourceUri, ...STATUS[tool] } };
}

const storyId = z.string().min(1).max(64).describe("The storyId returned with the story's most recent scene.");

/** What the scene view (and any MCP client) receives as structuredContent. */
export interface SceneView {
  [key: string]: unknown;
  kind: "scene";
  storyId: string;
  title: string;
  sceneNumber: number;
  totalScenes: number;
  status: Story["status"];
  mood: Scene["mood"];
  narration: string;
  question: string | null;
  suggestions: string[];
  /** What each earlier choice meant in the story, so hosts can answer "what did I choose?". */
  choicesSoFar: string[];
  soundCues: string[];
  visualPrompt: string;
  /** Artwork for the scene: a local illustration today, or a generated image later. */
  image?: SceneImage | null;
  /** Setting, allowlisted effects and intensity for animated clients. */
  presentation: ScenePresentation;
}

/** A published episode, as the scene view and any MCP client receive it. */
export interface EpisodeView {
  [key: string]: unknown;
  kind: "episode";
  storyId: string;
  title: string;
  creator: string;
  summary: string;
  minutes: number;
  language: string;
  /** The main storyline, as segment indexes in order (what "Listen without choices" plays). */
  path: number[];
  segments: {
    narration: string;
    mood: Scene["mood"];
    visualPrompt: string;
    presentation: ScenePresentation;
    /** Where the listener can decide what happens next. Options name segment indexes. */
    choices?: { prompt: string; options: { label: string; next: number }[] };
    next?: number;
    ending?: boolean;
  }[];
}

/** `user` is the signed-in listener, if any: their new stories are theirs, and only theirs to continue. */
export async function createHauntMcpServer(user?: User, guestKeyHash?: string): Promise<McpServer> {
  const server = new McpServer({ name: "haunt", title: "Haunt", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const view = await sceneView();
  const ui = (tool: SceneTool) => sceneUiMeta(tool, view.uri);
  const sceneResult = (tool: SceneTool, run: () => Promise<{ story: Story; scene: Scene; source?: string }>) =>
    guarded(async () => {
      const started = performance.now();
      const { story, scene, source = "saved" } = await run();
      const data = toSceneView(story, scene);
      data.image = await sceneImages.imageFor(scene, story).catch(() => null);
      return {
        // Same data as structuredContent, as in the Alexa+ examples. Hosts phrase the reply from it.
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        _meta: {
          // Alexa+ looks for the view in the tool response, not only in the tool definition.
          ...ui(tool),
          // How the scene was produced, for the inspector: "prewritten" answers skip generation.
          [DELIVERY_META_KEY]: { source, ms: Math.round(performance.now() - started) },
        },
      };
    });

  registerAppTool(
    server,
    "start_story",
    {
      title: "Start a story",
      description:
        "Use when the listener wants a new interactive scary, ghost or horror story, or says to start over. Writes the opening scene from their idea and returns narration plus a question for the listener. Not for finished episodes; use play_episode for those.",
      inputSchema: z.object({
        premise: z.string().min(1).max(500).describe("What the story is about, in the listener's words."),
        length: z
          .enum(["short", "medium", "long"])
          .optional()
          .describe("short (quick, about 4 scenes), medium (about 6), long (about 8). Defaults to medium."),
        intensity: z
          .enum(["eerie", "scary", "terrifying"])
          .optional()
          .describe("eerie (creepy, gentle), scary (default), terrifying (intense). Never graphic."),
        language: z.string().min(2).max(16).optional().describe("BCP 47 language tag, e.g. en or hi. Defaults to en."),
        subgenre: z
          .enum(SUBGENRE_IDS)
          .optional()
          .describe(`Horror sub-genre: one of ${SUBGENRE_IDS.join(", ")}. Shapes the setting, tone and scene artwork.`),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: ui("start_story"),
    },
    ({ premise, length, intensity, language, subgenre }) =>
      sceneResult("start_story", () =>
        engine.start(
          {
            premise,
            subgenre,
            intensity,
            language,
            targetScenes: length ? LENGTHS[length] : undefined,
          },
          { ownerId: user?.sub, guestKeyHash },
        ),
      ),
  );

  registerAppTool(
    server,
    "answer_story",
    {
      title: "Answer the narrator",
      description:
        "Use when the narrator has asked a question and the listener replies, in any words. Pass the reply verbatim; the story continues from their choice and returns the next scene.",
      inputSchema: z.object({
        storyId,
        answer: z.string().min(1).max(500).describe("Exactly what the listener said."),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: ui("answer_story"),
    },
    ({ storyId, answer }) => sceneResult("answer_story", async () => {
        await writableStory(storyId, user, guestKeyHash);
        return engine.decide(storyId, answer);
      }),
  );

  registerAppTool(
    server,
    "end_story",
    {
      title: "End the story",
      description: "Use when the listener wants the current story to finish now. Writes a proper final scene instead of stopping abruptly.",
      inputSchema: z.object({ storyId }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: ui("end_story"),
    },
    ({ storyId }) => sceneResult("end_story", async () => {
        await writableStory(storyId, user, guestKeyHash);
        return engine.finish(storyId);
      }),
  );

  registerAppTool(
    server,
    "resume_story",
    {
      title: "Resume a story",
      description:
        "Use when the listener wants to continue an earlier story, or asks where they were or what they chose. Returns the latest scene and the choices so far.",
      inputSchema: z.object({ storyId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: ui("resume_story"),
    },
    ({ storyId }) =>
      sceneResult("resume_story", async () => {
        const story = await ownedStory(storyId, user, guestKeyHash);
        const scene = story.scenes.at(-1);
        if (!scene) throw new StoryStateError("This story has no scenes yet.");
        return { story, scene };
      }),
  );

  server.registerTool(
    "list_library",
    {
      title: "Browse the library",
      description:
        "Use when the listener wants to hear a finished story rather than make one, or asks what stories there are. Lists finished episodes, newest first.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(async () => {
        const episodes = await episodeSummaries(await communityEntries());
        const data = episodes.length
          ? { episodes }
          : { episodes, message: "No finished episodes yet. Offer to start a new story instead." };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      }),
  );

  server.registerTool(
    "list_my_stories",
    {
      title: "List my stories",
      description:
        "Use when the listener asks for their own stories, what they were listening to, or wants to continue a story without saying which. Lists the stories they started, most recent first, and where each one stopped. Continue one with resume_story.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(async () => {
        const stories = (await storiesFor(user, guestKeyHash)).slice(0, MY_STORIES_LIMIT).map(myStoryItem);
        const data = stories.length
          ? { stories }
          : { stories, message: "The listener hasn't started a story yet. Offer to start one with start_story." };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      }),
  );

  server.registerTool(
    "get_home",
    {
      title: "Home",
      description:
        "Use when the listener opens Haunt, says home, or asks what to listen to tonight. Returns tonight's community story, the listener's most recent unfinished story (continue it with resume_story), and a few more community stories (play them with play_episode).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(async () => {
        const [entries, mine] = await Promise.all([communityEntries(), storiesFor(user, guestKeyHash)]);
        const featuredId = await featuredTonight(entries);
        const tonight = entries.find((entry) => entry.episode.storyId === featuredId) ?? entries[0];
        const [tonightView, ...more] = await episodeSummaries(
          tonight ? [tonight, ...entries.filter((entry) => entry !== tonight).slice(0, HOME_MORE)] : [],
        );
        const unfinished = mine.find((story) => story.status === "active");
        const data = {
          tonight: tonightView ?? null,
          continueStory: unfinished ? myStoryItem(unfinished) : null,
          more,
          myStoryCount: mine.length,
        };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      }),
  );

  registerAppTool(
    server,
    "play_episode",
    {
      title: "Play an episode",
      description:
        "Use when the listener picks an episode from the library. Returns its full narration to play straight through, with no questions.",
      inputSchema: z.object({ storyId: z.string().min(1).max(64).describe("The storyId from list_library.") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: ui("play_episode"),
    },
    ({ storyId }) =>
      guarded(async () => {
        const entry = await library.get(storyId);
        if (!entry) throw new StoryNotFoundError(storyId);
        const { episode } = entry;
        const data: EpisodeView = {
          kind: "episode",
          storyId: episode.storyId,
          title: episode.title,
          creator: entry.creator,
          summary: entry.summary,
          minutes: episode.estimatedMinutes,
          language: episode.language,
          // Presentation is computed on the way out, so episodes published before it existed get artwork too.
          path: mainPath(episode.segments),
          segments: episode.segments.map(({ narration, mood, visualPrompt, soundCues, choices, next, ending }) => ({
            narration,
            mood,
            visualPrompt,
            presentation: selectPresentation({ mood, visualPrompt, narration, soundCues }),
            ...(choices ? { choices } : {}),
            ...(next !== undefined ? { next } : {}),
            ...(ending ? { ending } : {}),
          })),
        };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, _meta: ui("play_episode") };
      }),
  );

  registerAppResource(
    server,
    "Haunt scene",
    view.uri,
    { description: "Scene view: artwork, captions and the narrator's question." },
    async () => ({ contents: [{ uri: view.uri, mimeType: RESOURCE_MIME_TYPE, text: view.html }] }),
  );

  return server;
}

/** Community stories, newest first. Haunt Originals have their own list (GET /api/originals). */
async function communityEntries(): Promise<LibraryEntry[]> {
  return uniqueEntries(await library.list()).filter((entry) => entry.source !== "HAUNT_ORIGINAL");
}

/** What list_library and get_home tell a host about a community story. */
async function episodeSummaries(entries: LibraryEntry[]) {
  // Live totals (engagement.ts). null when the database isn't available, so no count is shown rather than a false zero.
  const totals = await Promise.all(
    entries.map((entry) => (engagement ? engagement.counts(entry.episode.storyId).catch(() => null) : null)),
  );
  return entries.map((entry, i) => ({
    storyId: entry.episode.storyId,
    title: entry.episode.title,
    summary: entry.summary,
    creator: entry.creator,
    minutes: entry.episode.estimatedMinutes,
    language: entry.episode.language,
    // Lets listeners tell apart different stories that share a title or premise.
    parts: mainPath(entry.episode.segments).length,
    publishedAt: entry.publishedAt,
    likes: totals[i]?.likes ?? null,
    plays: totals[i]?.plays ?? null,
  }));
}

/** One of the listener's own stories, as list_my_stories and get_home return it. Never the owner or guest key. */
function myStoryItem(story: Story) {
  return {
    storyId: story.id,
    title: story.title || "Untitled",
    status: story.status,
    sceneNumber: story.scenes.length,
    totalScenes: Math.max(story.config.targetScenes, story.scenes.length),
    lastQuestion: story.status === "active" ? (story.scenes.at(-1)?.question?.prompt ?? null) : null,
    updatedAt: story.updatedAt,
  };
}

/**
 * The community story an admin featured for tonight (Featured Tonight, featured.ts), when that's switched on and the story is
 * still listed. Otherwise undefined, and Home shows the newest community story.
 */
async function featuredTonight(entries: LibraryEntry[]): Promise<string | undefined> {
  if (process.env.HAUNT_FEATURED !== "on" || !dynamo) return undefined;
  try {
    const { entries: schedule } = await dynamoFeaturedStore(dynamo, config.statsTable).read();
    const listed = new Set(entries.map((entry) => entry.episode.storyId));
    return activeFeatured(schedule, Date.now()).find((feature) => listed.has(feature.storyId))?.storyId;
  } catch (error) {
    console.error("[mcp] featured read failed:", (error as Error).name);
    return undefined;
  }
}

function toSceneView(story: Story, scene: Scene): SceneView {
  return {
    kind: "scene",
    storyId: story.id,
    title: story.title,
    sceneNumber: scene.index + 1,
    totalScenes: Math.max(story.config.targetScenes, story.scenes.length),
    status: story.status,
    mood: scene.mood,
    narration: scene.narration,
    question: scene.question?.prompt ?? null,
    suggestions: scene.question?.suggestions ?? [],
    choicesSoFar: story.decisions.map((decision) => decision.outcome),
    soundCues: scene.soundCues,
    visualPrompt: scene.visualPrompt,
    presentation: selectPresentation({
      mood: scene.mood,
      visualPrompt: scene.visualPrompt,
      narration: scene.narration,
      soundCues: scene.soundCues,
      decisionOutcome: story.decisions.find((decision) => decision.sceneIndex === scene.index - 1)?.outcome,
      requested: scene.effects,
    }),
  };
}

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StoryNotFoundError) {
      return toolError("That story no longer exists. Offer to start a new one with start_story.");
    }
    if (error instanceof StoryStateError) return toolError(error.message);
    if (error instanceof StoryRefusalError) {
      return toolError("The narrator can't take the story in that direction. Ask the listener to choose something else.");
    }
    if (error instanceof z.ZodError) {
      return toolError(z.prettifyError(error));
    }
    console.error("[mcp] tool failed:", error);
    return toolError("The next scene couldn't be written just now. Ask the listener to repeat their answer, then try again.");
  }
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

interface SceneViewResource {
  uri: string;
  html: string;
  mtimeMs: number;
}

let cachedView: SceneViewResource | undefined;

/**
 * The built scene view and a URI versioned by its content hash, so hosts that cache
 * ui:// resources (as Alexa+ recommends) pick up new builds.
 */
async function sceneView(): Promise<SceneViewResource> {
  const file = path.join(config.viewsDir, "scene.html");
  try {
    if (cachedView && config.production) return cachedView;
    const { mtimeMs } = await stat(file);
    if (cachedView?.mtimeMs === mtimeMs) return cachedView;
    const html = await readFile(file, "utf8");
    const hash = createHash("sha256").update(html).digest("hex").slice(0, 10);
    cachedView = { uri: `ui://haunt/scene-${hash}.html`, html, mtimeMs };
    return cachedView;
  } catch {
    throw new Error("Scene view not built. Run: npm run build -w @haunt/views");
  }
}
