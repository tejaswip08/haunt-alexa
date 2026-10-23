import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confirmEmail, countLine, listLine, parseEchoCommand, parseSpokenCode, parseSpokenEmail, sayAddress, speakEmail, spellCode } from "../src/lib/echo-menu.ts";

describe("The Echo's spoken menus", () => {
  it("hears the main menu choices as whole sentences", () => {
    assert.deepEqual(parseEchoCommand("Community stories"), { kind: "community" });
    assert.deepEqual(parseEchoCommand("I want to listen to community stories"), { kind: "community" });
    assert.deepEqual(parseEchoCommand("My stories"), { kind: "mine" });
    assert.deepEqual(parseEchoCommand("continue my story"), { kind: "mine" });
    assert.deepEqual(parseEchoCommand("Continue my last story"), { kind: "continue-last" });
    assert.deepEqual(parseEchoCommand("Create a story"), { kind: "create" });
    assert.deepEqual(parseEchoCommand("make a new story"), { kind: "create" });
    assert.deepEqual(parseEchoCommand("What can I say?"), { kind: "menu" });
    assert.deepEqual(parseEchoCommand("go home"), { kind: "menu" });
    assert.deepEqual(parseEchoCommand("sign in"), { kind: "sign-in" });
    assert.deepEqual(parseEchoCommand("log out"), { kind: "sign-out" });
  });

  it("leaves story answers and requests for the story and the assistant", () => {
    assert.equal(parseEchoCommand("I open the door to the community hall"), null);
    assert.equal(parseEchoCommand("Tell me a scary story about a train"), null);
    assert.equal(parseEchoCommand("stop"), null);
    assert.equal(parseEchoCommand("Create a terrifying cosmic horror story in Hindi about a lighthouse"), null);
  });

  it("reads lists, codes and addresses so they can be followed by ear", () => {
    assert.equal(
      listLine(countLine(2, "There is one story.", "There are # stories."), [{ title: "The Smiling House", detail: "by rajeshm" }, { title: "Caught on Camera" }]),
      "There are 2 stories. One: The Smiling House, by rajeshm. Two: Caught on Camera. Which one? Say a number or a title.",
    );
    assert.equal(countLine(1, "You have one story.", "You have # stories."), "You have one story.");
    assert.match(listLine("Six.", Array.from({ length: 6 }, (_, i) => ({ title: `S${i}` }))), /Five: S4\. Those are the newest 5\./);
    assert.equal(parseSpokenEmail("my email is tejaswi at mobil80 dot com"), "tejaswi@mobil80.com");
    assert.equal(parseSpokenEmail("Tejaswi at Mobil 80 dot com"), "tejaswi@mobil80.com");
    assert.equal(parseSpokenEmail("tejaswi.sagar at mobil80 dot co dot uk"), "tejaswi.sagar@mobil80.co.uk");
    assert.equal(parseSpokenEmail("ada underscore lovelace at example dot com"), "ada_lovelace@example.com");
    assert.equal(parseSpokenEmail("reader@example.com"), "reader@example.com");
    assert.equal(parseSpokenEmail("tejaswi p eight one one at gmail dot com"), "tejaswip811@gmail.com");
    assert.equal(parseSpokenEmail("tejaswi p eight hundred and eleven at the rate gmail dot com"), "tejaswip811@gmail.com");
    assert.equal(parseSpokenEmail("tejaswi p eight eleven at gmail dot com"), "tejaswip811@gmail.com");
    assert.equal(parseSpokenEmail("tejaswi p 8 double 1 at g mail dot com"), "tejaswip811@gmail.com");
    assert.equal(parseSpokenEmail("t e j a s w i p 8 1 1 at the rate gmail.com"), "tejaswip811@gmail.com");
    assert.equal(parseSpokenEmail("tejaswip811@gmail.com"), "tejaswip811@gmail.com");
    assert.equal(parseSpokenEmail("hello there"), null);
    assert.equal(confirmEmail("tejaswip811@gmail.com"), "t, e, j, a, s, w, i, p, 8, 1, 1, at gmail dot com");
    assert.equal(parseSpokenCode("one two three four five six seven eight"), "12345678");
    assert.equal(parseSpokenCode("my code is 1234 5678"), "12345678");
    assert.equal(parseSpokenCode("oh one two"), "012");
    assert.equal(parseSpokenCode("twelve thirty"), null);
    assert.equal(speakEmail("tejaswi@mobil80.com"), "tejaswi at mobil80 dot com");
    assert.equal(spellCode("7S38-KC4F"), "7, S, 3, 8, dash, K, C, 4, F");
    assert.equal(sayAddress("http://localhost:5173/activate"), "localhost colon 5173 slash activate");
  });
});
