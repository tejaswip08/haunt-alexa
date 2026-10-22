import { randomUUID } from "node:crypto";
import { exportEpisode, type Episode } from "./episode.ts";
import { createWordMatcher, type AnswerMatcher } from "./matching.ts";
import type { SceneRequest, StoryProvider } from "./provider.ts";
import { sanitizeEffects } from "./presentation.ts";
import { MemoryStore, type StoryStore } from "./storage.ts";
import {
  SceneDraftSchema,
  StoryConfigSchema,
  type Character,
  type Scene,
  type SceneDraft,
  type Story,
  type StoryConfigInput,
  type StoryTurn,
  type TurnSource,
} from "./types.ts";

export interface StoryEngineOptions {
  provider: StoryProvider;
  store?: StoryStore;
  newId?: () => string;
  now?: () => Date;
  /**
   * Pre-write the next scene for each suggested answer while the listener is still
   * hearing the current one. A matching answer then continues instantly. Costs one
   * extra generation per suggestion.
   */
  prewrite?: boolean;
  /** Decides whether an answer matches a suggestion. Defaults to near-exact wording. */
  matcher?: AnswerMatcher;
}

interface Branches {
  sceneIndex: number;
  options: string[];
  drafts: Promise<SceneDraft | undefined>[];
}

export class StoryNotFoundError extends Error {
  constructor(readonly storyId: string) {
    super(`No story with id "${storyId}"`);
    this.name = "StoryNotFoundError";
  }
}

/** The request doesn't fit the story's current state (e.g. answering a finished story). */
export class StoryStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryStateError";
  }
}

const FALLBACK_QUESTION = "What do you do?";
const MAX_ANSWER_LENGTH = 500;

export class StoryEngine {
  readonly provider: StoryProvider;
  readonly store: StoryStore;
  #newId: () => string;
  #now: () => Date;
  #locks = new Map<string, Promise<unknown>>();
  #prewrite: boolean;
  #matcher: AnswerMatcher;
  #branches = new Map<string, Branches>();

  constructor(options: StoryEngineOptions) {
    this.provider = options.provider;
    this.store = options.store ?? new MemoryStore();
    this.#newId = options.newId ?? (() => `st_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
    this.#now = options.now ?? (() => new Date());
    this.#prewrite = options.prewrite ?? false;
    this.#matcher = options.matcher ?? createWordMatcher();
  }

  async start(input: StoryConfigInput, options: { ownerId?: string; guestKeyHash?: string } = {}): Promise<StoryTurn> {
    const config = StoryConfigSchema.parse(input);
    const at = this.#now().toISOString();
    const story: Story = {
      id: this.#newId(),
      title: "",
      config,
      status: "active",
      phase: "opening",
      world: "",
      characters: [],
      facts: [],
      scenes: [],
      decisions: [],
      ...(options.ownerId ? { ownerId: options.ownerId } : options.guestKeyHash ? { guestKeyHash: options.guestKeyHash } : {}),
      createdAt: at,
      updatedAt: at,
    };
    return this.#advance(story, { kind: "opening", story });
  }

  /** Answer the pending question and write the next scene. */
  async decide(storyId: string, answer: string): Promise<StoryTurn> {
    return this.#withLock(storyId, async () => {
      const story = await this.get(storyId);
      const trimmed = answer.trim().slice(0, MAX_ANSWER_LENGTH);
      if (!trimmed) throw new StoryStateError("The answer is empty.");
      if (story.status === "completed") throw new StoryStateError("This story has already ended.");
      const last = story.scenes.at(-1);
      if (!last?.question) throw new StoryStateError("There is no question waiting for an answer.");

      const isFinalScene = story.scenes.length + 1 >= story.config.targetScenes;
      const request: SceneRequest = isFinalScene
        ? { kind: "ending", story, answer: trimmed }
        : { kind: "continue", story, answer: trimmed };

      const branches = this.#branches.get(storyId);
      this.#branches.delete(storyId);
      if (branches?.sceneIndex === last.index) {
        const index = await this.#matcher
          .match(trimmed, branches.options, { question: last.question.prompt })
          .catch(() => null);
        const draft = index === null ? undefined : await branches.drafts[index];
        if (draft) return this.#apply(story, request, draft, "prewritten");
      }
      return this.#advance(story, request);
    });
  }

  /** End the story now with a final scene, whatever the remaining scene budget. */
  async finish(storyId: string): Promise<StoryTurn> {
    return this.#withLock(storyId, async () => {
      const story = await this.get(storyId);
      const last = story.scenes.at(-1);
      if (story.status === "completed" && last) return { story, scene: last, source: "live" };
      this.#branches.delete(storyId);
      return this.#advance(story, { kind: "ending", story });
    });
  }

  async get(storyId: string): Promise<Story> {
    const story = await this.store.get(storyId);
    if (!story) throw new StoryNotFoundError(storyId);
    return story;
  }

  async episode(storyId: string): Promise<Episode> {
    const story = await this.get(storyId);
    if (story.status !== "completed") throw new StoryStateError("Episodes are exported once a story has ended.");
    return exportEpisode(story);
  }

  async #advance(story: Story, request: SceneRequest): Promise<StoryTurn> {
    const draft = SceneDraftSchema.parse(await this.provider.writeScene(request));
    return this.#apply(story, request, draft, request.kind === "opening" ? "opening" : "live");
  }

  /** Fold a validated draft into the story, save it, and start pre-writing what comes next. */
  async #apply(story: Story, request: SceneRequest, draft: SceneDraft, source: TurnSource): Promise<StoryTurn> {
    const at = this.#now().toISOString();
    const ending = request.kind === "ending" || draft.isEnding;

    const narration = draft.narration.trim();
    if (!narration) throw new Error(`Provider ${this.provider.name} returned an empty scene.`);

    const question = ending
      ? null
      : {
          prompt: draft.question.trim() || FALLBACK_QUESTION,
          suggestions: draft.suggestions.map((s) => s.trim()).filter(Boolean).slice(0, 3),
        };

    const scene: Scene = {
      index: story.scenes.length,
      narration,
      mood: ending ? "ending" : draft.mood,
      soundCues: draft.soundCues.slice(0, 4),
      visualPrompt: draft.visualPrompt.trim(),
      ...(draft.effects?.length ? { effects: sanitizeEffects(draft.effects) } : {}),
      question,
      createdAt: at,
    };

    const previous = story.scenes.at(-1);
    if (request.kind !== "opening" && request.answer !== undefined && previous?.question) {
      story.decisions.push({
        sceneIndex: previous.index,
        question: previous.question.prompt,
        answer: request.answer,
        outcome: draft.decisionOutcome.trim() || request.answer,
        at,
      });
    }

    story.title = story.title || draft.title.trim() || "Untitled";
    story.world = story.world || draft.world.trim();
    story.characters = mergeCharacters(story.characters, draft.newCharacters);
    story.facts = mergeFacts(story.facts, draft.newFacts);
    story.phase = ending ? "resolution" : draft.phase;
    story.status = ending ? "completed" : "active";
    story.scenes.push(scene);
    story.updatedAt = at;

    await this.store.put(story);
    this.#startPrewriting(story);
    return { story, scene, source };
  }

  #startPrewriting(story: Story) {
    const scene = story.scenes.at(-1);
    const options = scene?.question?.suggestions ?? [];
    if (!this.#prewrite || story.status !== "active" || !scene || options.length === 0) return;
    // The provider gets its own copy, so later changes to `story` can't leak into a branch.
    const snapshot = structuredClone(story);
    const ending = snapshot.scenes.length + 1 >= snapshot.config.targetScenes;
    const drafts = options.map((answer) =>
      this.provider
        .writeScene(ending ? { kind: "ending", story: snapshot, answer } : { kind: "continue", story: snapshot, answer })
        .then((draft) => SceneDraftSchema.parse(draft))
        .catch(() => undefined),
    );
    this.#branches.set(story.id, { sceneIndex: scene.index, options, drafts });
  }

  /** Serializes work per story so two quick answers can't fork the plot. */
  async #withLock<T>(storyId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(storyId) ?? Promise.resolve();
    const current = previous.then(work, work);
    const settled = current.catch(() => undefined);
    this.#locks.set(storyId, settled);
    try {
      return await current;
    } finally {
      if (this.#locks.get(storyId) === settled) this.#locks.delete(storyId);
    }
  }
}

export function createStoryEngine(options: StoryEngineOptions) {
  return new StoryEngine(options);
}

function mergeCharacters(existing: Character[], incoming: SceneDraft["newCharacters"]) {
  const known = new Set(existing.map((c) => c.name.trim().toLowerCase()));
  const added = incoming.filter((c) => c.name.trim() && !known.has(c.name.trim().toLowerCase()));
  return [...existing, ...added];
}

function mergeFacts(existing: string[], incoming: string[]) {
  const known = new Set(existing.map((f) => f.trim().toLowerCase()));
  const added = incoming.map((f) => f.trim()).filter((f) => f && !known.has(f.toLowerCase()));
  return [...existing, ...added];
}
