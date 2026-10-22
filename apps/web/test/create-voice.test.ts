import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeFields, parseCreateCommand, premiseFor, DEFAULT_FORM } from "../src/lib/create-voice.ts";

describe("Creating a story by voice on the Echo Show", () => {
  it("reads every field from one sentence, and starts it", () => {
    assert.deepEqual(parseCreateCommand("Make a short, terrifying cosmic horror story in Hindi about a lighthouse that lights itself, and start it"), {
      fields: { subgenre: "cosmic", length: "short", intensity: "terrifying", language: "hi", idea: "a lighthouse that lights itself" },
      action: "generate",
    });
  });

  it("sets one field at a time", () => {
    assert.deepEqual(parseCreateCommand("Haunted house").fields, { subgenre: "haunted-house" });
    assert.deepEqual(parseCreateCommand("make it long").fields, { length: "long" });
    assert.deepEqual(parseCreateCommand("terrifying please").fields, { intensity: "terrifying" });
    assert.deepEqual(parseCreateCommand("very scary").fields, { intensity: "terrifying" });
    assert.deepEqual(parseCreateCommand("something creepy").fields, { intensity: "eerie" });
    assert.deepEqual(parseCreateCommand("in Tamil").fields, { language: "ta" });
    assert.deepEqual(parseCreateCommand("Español").fields, { language: "es" });
    assert.deepEqual(parseCreateCommand("my idea is a door that won't stay shut").fields, { idea: "a door that won't stay shut" });
    assert.deepEqual(parseCreateCommand("no idea").fields, { idea: "" });
  });

  it("keeps words inside the idea from changing other fields", () => {
    assert.deepEqual(parseCreateCommand("a ghost story about a long night in a slasher film").fields, {
      subgenre: "ghost",
      idea: "a long night in a slasher film",
    });
  });

  it("recognises generate and open, and only generate at the end of a sentence", () => {
    assert.equal(parseCreateCommand("generate").action, "generate");
    assert.equal(parseCreateCommand("okay start the story").action, "generate");
    assert.equal(parseCreateCommand("create a new story").action, "open");
    assert.equal(parseCreateCommand("I want to make my own story").action, "open");
    assert.equal(parseCreateCommand("about a choir that will start singing at midnight").action, null);
  });

  it("leaves story answers and other requests alone", () => {
    assert.deepEqual(parseCreateCommand("I open the basement door"), { fields: {}, action: null });
    assert.equal(parseCreateCommand("Tell me a scary story about the last train").action, null);
  });

  it("describes what changed, and builds a premise when there is no idea", () => {
    assert.deepEqual(describeFields({ subgenre: "folk", language: "fr", idea: "" }), ["Folk Horror", "French", "idea cleared"]);
    assert.equal(premiseFor({ ...DEFAULT_FORM, subgenre: "cosmic" }), "A cosmic horror story.");
    assert.equal(premiseFor({ ...DEFAULT_FORM, idea: " a drowned bell " }), "a drowned bell");
  });
});
