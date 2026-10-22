import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickNext, type Box } from "../src/lib/dpad.ts";

// Geometry measured on /tv at 1280×720 when the bug appeared (library row with nine cards).
const card = (left: number, width = 238): Box => ({ left, top: 511, width, height: 63 });
const libraryRow = [card(64), card(318), card(571), card(825, 281), card(1127, 241), card(1381), card(1635), card(1889), card(2143)];
const chips: Box[] = [
  { left: 139, top: 607, width: 172, height: 40 }, // Length: Short
  { left: 326, top: 607, width: 193, height: 40 }, // Medium
  { left: 894, top: 650, width: 168, height: 30 }, // Animations
  { left: 1088, top: 650, width: 128, height: 30 }, // Privacy & terms
];
const storyCards: Box[] = [64, 343, 622, 901].map((left) => ({ left, top: 210, width: 263, height: 244 }));

describe("Remote navigation", () => {
  it("Right walks the library row card by card instead of jumping to the chips below", () => {
    const all = [...libraryRow, ...chips, ...storyCards];
    let at = 0;
    const visited = [at];
    for (let step = 0; step < libraryRow.length - 1; step++) {
      const others = all.filter((_, i) => i !== at);
      const next = others[pickNext(all[at]!, others, "ArrowRight")]!;
      at = all.indexOf(next);
      visited.push(at);
    }
    assert.deepEqual(visited, [0, 1, 2, 3, 4, 5, 6, 7, 8], "all nine cards in order");
  });

  it("Left walks back along the same row", () => {
    const others = [...libraryRow.slice(0, 4), ...chips];
    assert.equal(pickNext(libraryRow[4]!, others, "ArrowLeft"), 3);
  });

  it("Up and Down still move between rows", () => {
    // Down from the first story card lands on the library row, not a chip.
    const below = [...libraryRow, ...chips];
    assert.ok(pickNext(storyCards[0]!, below, "ArrowDown") < libraryRow.length);
    // Up from a library card returns to a story card.
    assert.ok(pickNext(libraryRow[1]!, storyCards, "ArrowUp") >= 0);
    // Down from the library row reaches the chips.
    assert.ok(pickNext(libraryRow[0]!, chips, "ArrowDown") >= 0);
  });

  it("returns -1 when nothing lies in that direction", () => {
    assert.equal(pickNext(libraryRow[8]!, libraryRow.slice(0, 8), "ArrowRight"), -1);
  });
});
