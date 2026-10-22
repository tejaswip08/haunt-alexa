import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLocalArtProvider, createMockProvider, createStoryEngine, pickSceneArt } from "../src/index.ts";

describe("Scene images", () => {
  it("picks an illustration from the image prompt", () => {
    assert.equal(pickSceneArt("A lighthouse on a black rock at night", "uneasy"), "lighthouse");
    assert.equal(pickSceneArt("An empty platform as the last train arrives", "calm"), "train");
    assert.equal(pickSceneArt("A dark hospital ward with one lit bed", "threat"), "hospital");
  });

  it("falls back to the mood when nothing matches", () => {
    assert.equal(pickSceneArt("Something indistinct", "threat"), "figure");
    assert.equal(pickSceneArt("", "exploration"), "forest");
  });

  it("labels local artwork as not generated", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story, scene } = await engine.start({ premise: "A lighthouse that lights itself" });
    const image = await createLocalArtProvider().imageFor(scene, story);
    assert.equal(image?.generated, false);
    assert.equal(image?.alt, scene.visualPrompt);
    assert.ok(image?.art);
  });
});
