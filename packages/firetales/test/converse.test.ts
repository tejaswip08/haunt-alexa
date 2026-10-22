import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStoryEngine, StoryRefusalError, type SceneDraft } from "../src/index.ts";
import { createConverseProvider, parseScene } from "../src/providers/converse.ts";

const draft: SceneDraft = {
  title: "The Last Train",
  world: "An empty station at midnight.",
  decisionOutcome: "",
  narration: "The platform lights flicker as the last train pulls in.",
  mood: "uneasy",
  soundCues: ["distant train horn"],
  visualPrompt: "An empty platform under flickering lights.",
  question: "Do you board the train?",
  suggestions: ["Board the train", "Wait on the platform"],
  newFacts: ["The train has no driver."],
  newCharacters: [],
  phase: "opening",
  isEnding: false,
};

const toolResponse = (input: unknown) => ({
  stopReason: "tool_use" as const,
  output: { message: { role: "assistant" as const, content: [{ toolUse: { toolUseId: "t1", name: "write_scene", input } }] } },
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
});

describe("Converse provider", () => {
  it("parses the forced tool call into a scene", () => {
    assert.deepEqual(parseScene(toolResponse(draft) as never), draft);
  });

  it("rejects a tool call that does not match the scene schema", () => {
    assert.throws(() => parseScene(toolResponse({ ...draft, mood: "jolly" }) as never), /valid scene/);
  });

  it("treats filtered content as a refusal", () => {
    assert.throws(() => parseScene({ stopReason: "content_filtered", output: undefined }), StoryRefusalError);
  });

  it("drives the story engine and reports token usage", async () => {
    const usage: number[] = [];
    let request: { modelId?: string; toolConfig?: { toolChoice?: unknown } } | undefined;
    const client = {
      send: async (command: { input: typeof request }) => {
        request = command.input;
        return toolResponse(draft);
      },
    };
    const engine = createStoryEngine({
      provider: createConverseProvider({
        client: client as never,
        model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        onUsage: (u) => usage.push(u.totalTokens ?? 0),
      }),
      prewrite: false,
    });
    const { scene } = await engine.start({ premise: "The last train" });
    assert.equal(scene.question?.prompt, "Do you board the train?");
    assert.equal(request?.modelId, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
    assert.deepEqual(request?.toolConfig?.toolChoice, { tool: { name: "write_scene" } });
    assert.deepEqual(usage, [150]);
  });
});
