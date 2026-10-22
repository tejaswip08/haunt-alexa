import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeChoices, interpretSpeech } from "../src/lib/voice-intent.ts";

describe("Spoken replies on the TV", () => {
  it("passes story answers through verbatim", () => {
    assert.deepEqual(interpretSpeech("  I open the  basement door "), { kind: "answer", text: "I open the basement door" });
  });

  it("recognises player commands", () => {
    assert.equal(interpretSpeech("repeat that").kind, "repeat");
    assert.equal(interpretSpeech("Say it again").kind, "repeat");
    assert.equal(interpretSpeech("What are my choices?").kind, "choices");
    assert.equal(interpretSpeech("options").kind, "choices");
    assert.equal(interpretSpeech("End the story").kind, "end");
  });

  it("does not treat story actions that mention a command word as commands", () => {
    assert.equal(interpretSpeech("I repeat the chant in the circle").kind, "answer");
    assert.equal(interpretSpeech("stop the train").kind, "answer");
  });

  it("reads the suggestions as a sentence", () => {
    assert.equal(describeChoices(["Open the door", "Run"]), "You could say: open the door, or run. Or say anything you like.");
    assert.equal(describeChoices([]), "Say anything you like.");
  });
});
