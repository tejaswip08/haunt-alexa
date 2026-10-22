import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCENE_ART, SCENE_EFFECTS } from "@firetales/core";
import {
  DEFAULT_PRESENTATION,
  EFFECTS,
  loadMotionPreference,
  resolveMotion,
  sanitizePresentation,
  sceneArtSvg,
  SETTINGS,
} from "../src/index.ts";

describe("Presentation from the server", () => {
  it("keeps the client allowlists in step with the engine", () => {
    assert.deepEqual([...EFFECTS], [...SCENE_EFFECTS]);
    assert.deepEqual([...SETTINGS].sort(), [...SCENE_ART].sort());
  });

  it("passes valid presentation through", () => {
    const value = { setting: "train", effects: ["ambient_fog", "camera_shake"], intensity: "high" };
    assert.deepEqual(sanitizePresentation(value), value);
  });

  it("drops unknown effects and settings", () => {
    const value = sanitizePresentation({ setting: "<img onerror=x>", effects: ["door_opens", "javascript:alert(1)", 7], intensity: "max" });
    assert.equal(value.setting, DEFAULT_PRESENTATION.setting);
    assert.deepEqual(value.effects, ["door_opens"]);
    assert.equal(value.intensity, DEFAULT_PRESENTATION.intensity);
  });

  it("falls back to mood-based defaults when presentation is missing or malformed", () => {
    assert.deepEqual(sanitizePresentation(undefined), DEFAULT_PRESENTATION);
    assert.deepEqual(sanitizePresentation("fog please"), DEFAULT_PRESENTATION);
    assert.equal(sanitizePresentation(null, "threat").setting, "figure");
    assert.equal(sanitizePresentation({ effects: [] }, "threat").intensity, "high");
    assert.deepEqual(sanitizePresentation({ effects: ["nope"] }).effects, DEFAULT_PRESENTATION.effects);
  });

  it("caps the number of effects", () => {
    assert.ok(sanitizePresentation({ effects: [...EFFECTS] }).effects.length <= 5);
  });
});

describe("Motion settings", () => {
  it("follows an explicit choice", () => {
    assert.equal(resolveMotion("off", false, false), "off");
    assert.equal(resolveMotion("full", true, true), "full");
    assert.equal(resolveMotion("reduced", false, false), "reduced");
  });

  it("steps down automatically for reduced-motion users and slow devices", () => {
    assert.equal(resolveMotion("auto", false, false), "full");
    assert.equal(resolveMotion("auto", true, false), "reduced");
    assert.equal(resolveMotion("auto", false, true), "reduced");
  });

  it("survives missing or blocked storage", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      assert.equal(loadMotionPreference(), "auto");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("Illustrations", () => {
  it("draws every setting and escapes the alt text", () => {
    for (const setting of SETTINGS) assert.match(sceneArtSvg(setting, "x"), /^<svg/);
    const svg = sceneArtSvg("house", `"><script>alert(1)</script>`);
    assert.ok(!svg.includes("<script>"));
    assert.ok(svg.includes("&lt;script&gt;"));
  });
});
