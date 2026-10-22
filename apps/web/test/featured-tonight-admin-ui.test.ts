import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The admin panel reaches the browser-only speech module through the device connection, which reads `window` when it loads.
// Node has no window here, so give the module an empty one before importing the panel. Nothing in this test uses it.
(globalThis as { window?: unknown }).window ??= globalThis;
const { FeaturedTonightAdmin } = await import("../src/components/FeaturedTonightAdmin.tsx");

// The first paint, before the schedule and the published stories load: the admin sees a loading state, not a form that
// could be submitted against an unknown schedule version.
describe("the Featured Tonight admin panel's first paint", () => {
  it("shows the heading, the UTC note and a loading state, and no save button yet", () => {
    const html = renderToStaticMarkup(createElement(FeaturedTonightAdmin));
    assert.match(html, /Featured Tonight/);
    assert.match(html, /Times are UTC/);
    assert.match(html, /Loading the schedule/);
    assert.doesNotMatch(html, /Save selection/);
  });
});
