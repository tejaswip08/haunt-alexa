import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createMockProvider,
  createStoryEngine,
  createWordMatcher,
  exportEpisode,
  FileStore,
  StoryNotFoundError,
  StoryStateError,
  type SceneDraft,
  type StoryProvider,
} from "../src/index.ts";

describe("StoryEngine", () => {
  it("starts a story with an opening scene and a question", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story, scene } = await engine.start({ premise: "The last train from a deserted station" });

    assert.equal(story.status, "active");
    assert.equal(story.scenes.length, 1);
    assert.equal(scene.index, 0);
    assert.ok(scene.narration.length > 0);
    assert.ok(scene.question?.prompt);
    assert.ok(story.title);
  });

  it("records decisions and ends after the target number of scenes", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    let turn = await engine.start({ premise: "A lighthouse that lights itself", targetScenes: 3 });
    turn = await engine.decide(turn.story.id, "Climb the stairs");
    assert.equal(turn.story.status, "active");
    turn = await engine.decide(turn.story.id, "Open the lamp room door");

    assert.equal(turn.story.status, "completed");
    assert.equal(turn.story.scenes.length, 3);
    assert.equal(turn.scene.question, null);
    assert.deepEqual(
      turn.story.decisions.map((d) => [d.sceneIndex, d.answer]),
      [
        [0, "Climb the stairs"],
        [1, "Open the lamp room door"],
      ],
    );
    await assert.rejects(engine.decide(turn.story.id, "Again"), StoryStateError);
  });

  it("exports an episode with narration only, never questions or answers", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    let turn = await engine.start({ premise: "A phone that rings from inside the wall", targetScenes: 3 });
    const questions = [turn.scene.question!.prompt];
    turn = await engine.decide(turn.story.id, "pick up the receiver");
    questions.push(turn.scene.question!.prompt);
    turn = await engine.decide(turn.story.id, "Whisper back");

    const episode = await engine.episode(turn.story.id);
    assert.equal(episode.segments.length, 3);
    for (const question of questions) assert.ok(!episode.script.includes(question), `script leaked: ${question}`);
  });

  it("only exports finished stories", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story } = await engine.start({ premise: "Footsteps in an empty attic" });
    await assert.rejects(engine.episode(story.id), StoryStateError);
  });

  it("finish() writes an ending early", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story } = await engine.start({ premise: "A mirror that lags behind", targetScenes: 8 });
    const turn = await engine.finish(story.id);
    assert.equal(turn.story.status, "completed");
    assert.equal(turn.story.scenes.length, 2);
    assert.equal(turn.scene.mood, "ending");
  });

  it("keeps facts and characters without duplicates", async () => {
    const provider = scriptedProvider([
      { newFacts: ["The station closed 23 years ago"], newCharacters: [{ name: "Arjun", description: "night guard" }] },
      { newFacts: ["The station closed 23 years ago", "The train appears at 2:13 AM"], newCharacters: [{ name: "arjun", description: "dup" }] },
    ]);
    const engine = createStoryEngine({ provider });
    const { story } = await engine.start({ premise: "Platform 9" });
    const turn = await engine.decide(story.id, "Board the train");
    assert.deepEqual(turn.story.facts, ["The station closed 23 years ago", "The train appears at 2:13 AM"]);
    assert.deepEqual(turn.story.characters.map((c) => c.name), ["Arjun"]);
  });

  it("does not save anything when the provider fails", async () => {
    let fail = false;
    const mock = createMockProvider();
    const provider: StoryProvider = {
      name: "flaky",
      writeScene: (request) => (fail ? Promise.reject(new Error("model down")) : mock.writeScene(request)),
    };
    const engine = createStoryEngine({ provider });
    const { story } = await engine.start({ premise: "A knock from below the floor" });
    fail = true;
    await assert.rejects(engine.decide(story.id, "Open the hatch"), /model down/);
    const saved = await engine.get(story.id);
    assert.equal(saved.scenes.length, 1);
    assert.equal(saved.decisions.length, 0);
  });

  it("serializes concurrent answers to the same story", async () => {
    const engine = createStoryEngine({ provider: createMockProvider({ delayMs: 20 }) });
    const { story } = await engine.start({ premise: "Two voices on the baby monitor", targetScenes: 6 });
    const results = await Promise.allSettled([engine.decide(story.id, "Run"), engine.decide(story.id, "Hide")]);
    const saved = await engine.get(story.id);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    assert.equal(saved.scenes.length, 3);
    assert.deepEqual(saved.decisions.map((d) => d.sceneIndex), [0, 1]);
  });

  it("throws StoryNotFoundError for unknown ids", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    await assert.rejects(engine.get("st_missing"), StoryNotFoundError);
  });
});

describe("FileStore", () => {
  it("persists stories across engine instances", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "firetales-"));
    try {
      const first = createStoryEngine({ provider: createMockProvider(), store: new FileStore(dir) });
      const { story } = await first.start({ premise: "The house at the end of Kiln Lane" });

      const second = createStoryEngine({ provider: createMockProvider(), store: new FileStore(dir) });
      const turn = await second.decide(story.id, "Ring the doorbell");
      assert.equal(turn.story.scenes.length, 2);
      assert.equal((await second.store.list()).length, 1);
      assert.equal(await second.store.get("../../etc/passwd"), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exportEpisode", () => {
  it("estimates duration from word count", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story } = await engine.start({ premise: "Snow that falls upward" });
    const episode = exportEpisode(story);
    assert.equal(episode.wordCount, episode.script.split(/\s+/).filter(Boolean).length);
    assert.ok(episode.estimatedMinutes >= 1);
  });
});

describe("pre-written branches", () => {
  function countingProvider() {
    const mock = createMockProvider();
    const provider = {
      name: "counting",
      calls: [] as string[],
      async writeScene(request: Parameters<StoryProvider["writeScene"]>[0]) {
        provider.calls.push("answer" in request && request.answer !== undefined ? request.answer : request.kind);
        return mock.writeScene(request);
      },
    };
    return provider;
  }

  it("writes a branch per suggestion and uses it when the answer matches", async () => {
    const provider = countingProvider();
    const engine = createStoryEngine({ provider, prewrite: true });
    const { story, scene } = await engine.start({ premise: "A well that whispers names" });
    const suggestions = scene.question!.suggestions;
    assert.deepEqual(provider.calls, ["opening", ...suggestions]);

    const turn = await engine.decide(story.id, `I'll ${suggestions[0]!.toLowerCase()}`);
    assert.equal(turn.source, "prewritten");
    assert.equal(turn.story.decisions[0]!.answer, `I'll ${suggestions[0]!.toLowerCase()}`, "keeps the listener's own words");
    // Only the next round of branches was written; the answer itself cost nothing.
    assert.deepEqual(provider.calls.slice(1 + suggestions.length), turn.scene.question!.suggestions);
  });

  it("writes live when the answer doesn't match a suggestion", async () => {
    const provider = countingProvider();
    const engine = createStoryEngine({ provider, prewrite: true });
    const { story } = await engine.start({ premise: "A well that whispers names" });
    const turn = await engine.decide(story.id, "Drop a coin and make a wish");
    assert.equal(turn.source, "live");
    assert.ok(provider.calls.includes("Drop a coin and make a wish"));
  });

  it("falls back to live writing when a branch failed", async () => {
    const mock = createMockProvider();
    let failBranches = true;
    const provider: StoryProvider = {
      name: "flaky-branches",
      writeScene: (request) =>
        failBranches && "answer" in request && request.answer !== undefined
          ? Promise.reject(new Error("branch failed"))
          : mock.writeScene(request),
    };
    const engine = createStoryEngine({ provider, prewrite: true });
    const { story, scene } = await engine.start({ premise: "Footsteps on the ceiling" });
    failBranches = false;
    const turn = await engine.decide(story.id, scene.question!.suggestions[0]!);
    assert.equal(turn.source, "live");
    assert.equal(turn.story.scenes.length, 2);
  });

  it("is off by default", async () => {
    const provider = countingProvider();
    const engine = createStoryEngine({ provider });
    await engine.start({ premise: "A doll that changes rooms" });
    assert.deepEqual(provider.calls, ["opening"]);
  });
});

describe("createWordMatcher", () => {
  const matcher = createWordMatcher();
  const options = ["Follow the sound", "Hide under the bed"];
  const ask = (answer: string) => matcher.match(answer, options, { question: "Do you follow the sound, or hide?" });

  it("matches the same choice in other words", async () => {
    assert.equal(await ask("Follow the sound"), 0);
    assert.equal(await ask("I'll follow that sound."), 0);
    assert.equal(await ask("okay hide under the bed"), 1);
  });

  it("refuses negations, extra intent and unrelated answers", async () => {
    assert.equal(await ask("Don't follow the sound"), null);
    assert.equal(await ask("Follow the sound and call the police"), null);
    assert.equal(await ask("Run outside"), null);
    assert.equal(await ask(""), null);
  });
});

function scriptedProvider(overrides: Partial<SceneDraft>[]): StoryProvider {
  const mock = createMockProvider();
  let call = 0;
  return {
    name: "scripted",
    async writeScene(request) {
      return { ...(await mock.writeScene(request)), ...overrides[call++] };
    },
  };
}
