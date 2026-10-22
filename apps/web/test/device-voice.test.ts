import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGoHome, parseAccount, parseNavigation, pickStory } from "../src/lib/device-voice.ts";

describe("Voice navigation on the Echo Show", () => {
  it("opens every tab", () => {
    assert.deepEqual(parseNavigation("Go home"), { kind: "tab", tab: "home" });
    for (const phrase of ["go to home", "Go to the home screen", "go back home", "take me home", "back to home", "home", "home page", "go back", "exit"]) {
      assert.deepEqual(parseNavigation(phrase), { kind: "tab", tab: "home" }, phrase);
      assert.equal(isGoHome(phrase), true, phrase);
    }
    assert.deepEqual(parseNavigation("open community"), { kind: "tab", tab: "community" });
    assert.deepEqual(parseNavigation("Show me the library."), { kind: "tab", tab: "community" });
    assert.deepEqual(parseNavigation("my stories"), { kind: "tab", tab: "mine" });
    assert.deepEqual(parseNavigation("open create"), { kind: "tab", tab: "create" });
    assert.deepEqual(parseNavigation("Alexa, open my profile"), { kind: "tab", tab: "profile" });
  });

  it("plays and continues by position or by title", () => {
    assert.deepEqual(parseNavigation("play the first one"), { kind: "play", pick: { index: 0 } });
    assert.deepEqual(parseNavigation("play two"), { kind: "play", pick: { index: 1 } });
    assert.deepEqual(parseNavigation("play the last story"), { kind: "play", pick: { index: -1 } });
    assert.deepEqual(parseNavigation("listen to The Radio Under the Pillow"), { kind: "play", pick: { title: "radio under the pillow" } });
    assert.deepEqual(parseNavigation("continue my last story"), { kind: "continue", pick: { index: -1 } });
    assert.deepEqual(parseNavigation("resume the lighthouse"), { kind: "continue", pick: { title: "lighthouse" } });
  });

  it("only takes whole sentences, so ideas and answers pass through", () => {
    assert.equal(parseNavigation("a ghost story about my stories at camp"), null);
    assert.equal(parseNavigation("I open the basement door"), null);
    assert.equal(parseNavigation("Tell me a scary story"), null);
  });

  it("finds the story a pick refers to", () => {
    const list = [{ title: "The Story" }, { title: "The Lighthouse That Lights Itself" }, { title: "Hollow Pines" }];
    assert.equal(pickStory(list, { index: 1 })?.title, "The Lighthouse That Lights Itself");
    assert.equal(pickStory(list, { index: -1 })?.title, "Hollow Pines");
    assert.equal(pickStory(list, { title: "lighthouse" })?.title, "The Lighthouse That Lights Itself");
    assert.equal(pickStory(list, { title: "story" })?.title, "The Story");
    assert.equal(pickStory(list, { title: "nothing like this" }), undefined);
  });

  it("hears sign in and sign out, and nothing longer", () => {
    assert.equal(parseAccount("sign in"), "in");
    assert.equal(parseAccount("Alexa, log me in"), "in");
    assert.equal(parseAccount("signin to haunt"), "in");
    assert.equal(parseAccount("sign out please"), "out");
    assert.equal(parseAccount("log out"), "out");
    assert.equal(parseAccount("I sign in the guest book"), null);
    assert.equal(parseAccount("open community"), null);
  });
});
