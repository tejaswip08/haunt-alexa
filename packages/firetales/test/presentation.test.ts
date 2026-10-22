import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createStoryEngine,
  DEFAULT_PRESENTATION,
  sanitizeEffects,
  SCENE_EFFECTS,
  selectPresentation,
  type SceneDraft,
  type StoryProvider,
} from "../src/index.ts";

describe("Scene presentation", () => {
  it("running from a train feels different from entering a haunted house", () => {
    const train = selectPresentation({
      mood: "threat",
      visualPrompt: "A figure sprinting down an empty platform as the last train lurches forward",
      narration: "You run. Behind you the carriage doors slam, and the whole train lurches.",
      decisionOutcome: "They fled from the conductor.",
    });
    const house = selectPresentation({
      mood: "uneasy",
      visualPrompt: "An old house at night with one candle burning in the window",
      narration: "The front door creaks open on its own. A candle gutters at the end of the hall.",
    });
    assert.equal(train.setting, "train");
    assert.ok(train.effects.includes("camera_shake"));
    assert.equal(train.intensity, "high");
    assert.equal(house.setting, "house");
    assert.ok(house.effects.includes("door_opens"));
    assert.ok(house.effects.includes("flickering_light"));
    assert.ok(!house.effects.includes("camera_shake"));
  });

  it("drops unknown or malformed effect names", () => {
    assert.deepEqual(sanitizeEffects(["door_opens", "alert('x')", "<script>", 42, null, "DOOR_OPENS ", "door_opens"]), ["door_opens"]);
    assert.deepEqual(sanitizeEffects("camera_shake"), []);
    assert.deepEqual(sanitizeEffects(undefined), []);
  });

  it("never shakes a calm scene, even when a model asks for it", () => {
    const calm = selectPresentation({
      mood: "calm",
      visualPrompt: "A quiet kitchen at dawn",
      narration: "The kettle clicks off.",
      requested: ["camera_shake", "explode_screen"],
    });
    assert.ok(!calm.effects.includes("camera_shake"));
    assert.equal(calm.intensity, "low");
  });

  it("adds allowed effects a model suggests, in a stable order, within the cap", () => {
    const scene = selectPresentation({
      mood: "threat",
      visualPrompt: "A dark hospital ward",
      narration: "The lights stutter. A shadow crosses the far window. The ward door swings open. You run as the floor shakes.",
      requested: ["ambient_fog", "scene_fade"],
    });
    assert.ok(scene.effects.length <= 5);
    assert.deepEqual(scene.effects, SCENE_EFFECTS.filter((e) => scene.effects.includes(e)));
    assert.ok(scene.effects.includes("camera_shake"));
  });

  it("falls back to safe defaults when there is nothing to go on", () => {
    const empty = selectPresentation({ mood: "calm", visualPrompt: "", narration: "" });
    assert.equal(empty.setting, "house");
    assert.deepEqual(empty.effects, DEFAULT_PRESENTATION.effects);
  });

  it("stores only allowlisted effects suggested by the writer", async () => {
    const draft: SceneDraft = {
      title: "T", world: "W", decisionOutcome: "", narration: "N", mood: "uneasy", soundCues: [],
      visualPrompt: "V", question: "Q?", suggestions: ["A", "B"], newFacts: [], newCharacters: [],
      phase: "opening", isEnding: false, effects: ["ambient_fog", "rm -rf /", "door_opens"],
    };
    const provider: StoryProvider = { name: "fixed", writeScene: async () => draft };
    const { scene } = await createStoryEngine({ provider }).start({ premise: "x" });
    assert.deepEqual(scene.effects, ["ambient_fog", "door_opens"]);
  });
});
