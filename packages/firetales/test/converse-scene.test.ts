import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseScene } from "../src/providers/converse.ts";

// A scene as the model returns it through the forced write_scene tool call.
const scene = {
  title: "The Harvest Calls",
  world: "A village where the wheat remembers hunger.",
  narration: "The innkeeper's smile hardens.",
  mood: "threat",
  visualPrompt: "A stone church in amber light.",
  question: "Do you run?",
  phase: "rising_action",
  isEnding: false,
};

const response = (input: unknown) =>
  ({ stopReason: "tool_use", output: { message: { content: [{ toolUse: { name: "write_scene", input } }] } } }) as never;

describe("parsing a scene the model returns", () => {
  it("accepts a scene whose optional lists were left out", () => {
    const draft = parseScene(response(scene));
    assert.deepEqual(draft.newFacts, []);
    assert.deepEqual(draft.newCharacters, []);
    assert.deepEqual(draft.soundCues, []);
    assert.deepEqual(draft.suggestions, []);
    assert.equal(draft.decisionOutcome, "");
  });

  it("keeps the lists when the model supplies them", () => {
    const draft = parseScene(response({ ...scene, suggestions: ["Run", "Stay"], soundCues: ["distant bell"] }));
    assert.deepEqual(draft.suggestions, ["Run", "Stay"]);
    assert.deepEqual(draft.soundCues, ["distant bell"]);
  });

  it("still refuses a scene with no narration, so nothing empty is shown as a scene", () => {
    const { narration: _omitted, ...withoutNarration } = scene;
    assert.throws(() => parseScene(response(withoutNarration)), /did not return a valid scene/);
  });

  it("still refuses an unknown mood", () => {
    assert.throws(() => parseScene(response({ ...scene, mood: "cheerful" })), /did not return a valid scene/);
  });
});
