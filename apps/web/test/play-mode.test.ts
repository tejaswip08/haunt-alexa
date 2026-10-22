import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCancel, nextSegment, parsePlayMode, pickOption } from "../src/lib/play-mode.ts";

describe("Choosing how a story plays", () => {
  it("hears with choices and just listen, including the buttons' order", () => {
    assert.equal(parsePlayMode("With choices"), "choices");
    assert.equal(parsePlayMode("Alexa, play with choices"), "choices");
    assert.equal(parsePlayMode("let me choose"), "choices");
    assert.equal(parsePlayMode("one"), "choices");
    assert.equal(parsePlayMode("Just listen"), "listen");
    assert.equal(parsePlayMode("without choices"), "listen");
    assert.equal(parsePlayMode("I'll just listen"), "listen");
    assert.equal(parsePlayMode("the second one"), "listen");
    assert.equal(parsePlayMode("open community"), null);
    assert.equal(isCancel("never mind"), true);
    assert.equal(isCancel("listen"), false);
  });

  it("picks an option by position or by its words", () => {
    const labels = ["Follow the sound", "Hide in the cellar"];
    assert.equal(pickOption("two", labels), 1);
    assert.equal(pickOption("the first one", labels), 0);
    assert.equal(pickOption("option 2", labels), 1);
    assert.equal(pickOption("I choose hide in the cellar", labels), 1);
    assert.equal(pickOption("follow it, the sound", labels), 0);
    assert.equal(pickOption("three", labels), null);
    assert.equal(pickOption("what time is it", labels), null);
  });

  it("follows an episode's branches the way the server's main path does", () => {
    const segments = [
      { choices: { prompt: "?", options: [{ label: "a", next: 1 }, { label: "b", next: 3 }] } },
      {},
      { ending: true },
      { ending: true },
    ];
    assert.equal(nextSegment(segments, 0), 1);
    assert.equal(nextSegment(segments, 0, 1), 3);
    assert.equal(nextSegment(segments, 1), 2);
    assert.equal(nextSegment(segments, 2), undefined);
    assert.equal(nextSegment(segments, 3), undefined);
  });
});
