import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorizeStoryWrite } from "../src/story-write-access.ts";

// Who may change stories through MCP start_story, continue_story and friends. Reproduces the 403 a signed-in listener got
// ("Your account can't change stories. Creator access is needed.") and checks the refusals that must remain.
const listener = { sub: "listener-1" };
const creator = { sub: "creator-1" };

describe("who may start and continue stories through MCP", () => {
  it("lets a signed-in listener start a story (was refused with 403)", async () => {
    assert.equal(await authorizeStoryWrite(listener, "start_story", false, true), true);
    assert.equal(await authorizeStoryWrite(listener, "answer_story", false, true), true);
  });

  it("lets a creator and an admin start stories too", async () => {
    assert.equal(await authorizeStoryWrite(creator, "start_story", false, true), true);
  });

  it("keeps refusing external bearer-token clients, which have no user", async () => {
    assert.equal(await authorizeStoryWrite(undefined, "start_story", true, true), false);
    assert.equal(await authorizeStoryWrite(listener, "start_story", true, true), false);
  });

  it("keeps guests out of production, and lets guests play locally as before", async () => {
    assert.equal(await authorizeStoryWrite(undefined, "start_story", false, true), false);
    assert.equal(await authorizeStoryWrite(undefined, "start_story", false, false), true);
  });
});
