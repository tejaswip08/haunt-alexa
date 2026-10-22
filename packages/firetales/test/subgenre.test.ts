import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBrief } from "../src/providers/claude.ts";
import { createLocalArtProvider, createMockProvider, createStoryEngine, pickSceneArt, SUBGENRE_IDS, SUBGENRE_DEFAULT_ART } from "../src/index.ts";
import type { Scene } from "../src/types.ts";

const scene = (visualPrompt: string, mood: Scene["mood"] = "calm") => ({ visualPrompt, mood }) as Scene;

describe("the sub-genre on a story", () => {
  it("is kept on the story config from the start", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story } = await engine.start({ premise: "A ghost on the last train", subgenre: "ghost" });
    assert.equal(story.config.subgenre, "ghost");
  });

  it("is optional, so a story started without one stays general", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story } = await engine.start({ premise: "A lighthouse keeper" });
    assert.equal(story.config.subgenre, undefined);
  });

  it("accepts every canonical id and refuses anything else with a message naming the field", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    for (const id of SUBGENRE_IDS) await engine.start({ premise: "A cult", subgenre: id });
    await assert.rejects(engine.start({ premise: "A cult", subgenre: "Cult!" as never }), /subgenre/);
    await assert.rejects(engine.start({ premise: "A cult", subgenre: "cult story" as never }), /subgenre/);
    await assert.rejects(engine.start({ premise: "A cult", subgenre: "romance" as never }), /subgenre/);
  });

  it("has exactly the twelve canonical ids, each with a default illustration", () => {
    assert.equal(SUBGENRE_IDS.length, 12);
    for (const id of SUBGENRE_IDS) assert.ok(SUBGENRE_DEFAULT_ART[id], `${id} has a default art`);
  });

  it("reaches the writer in the brief the Claude provider sends", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story } = await engine.start({ premise: "Something in the walls", subgenre: "haunted-house" });
    const brief = buildBrief({ kind: "opening", story });
    assert.match(brief, /"subgenre": "haunted-house"/);
  });
});

describe("scene artwork and the sub-genre", () => {
  it("uses a place named in the scene's own prompt before the sub-genre", () => {
    assert.equal(pickSceneArt("a lighthouse on the cliff", "calm", "folk"), "lighthouse");
  });

  it("falls back to the sub-genre's illustration when the prompt names no place", () => {
    assert.equal(pickSceneArt("an unnamed presence", "calm", "creature"), "water");
    assert.equal(pickSceneArt("an unnamed presence", "calm", "folk"), "forest");
  });

  it("falls back to the mood when there is no sub-genre", () => {
    assert.equal(pickSceneArt("an unnamed presence", "suspense"), "door");
  });

  it("the local provider reads the sub-genre from the story it is given", async () => {
    const engine = createStoryEngine({ provider: createMockProvider() });
    const { story } = await engine.start({ premise: "Something under the ice", subgenre: "survival" });
    const provider = createLocalArtProvider();
    const image = await provider.imageFor(scene("an unnamed presence"), story);
    assert.equal(image?.art, "water");
    assert.equal(image?.generated, false);
  });
});
