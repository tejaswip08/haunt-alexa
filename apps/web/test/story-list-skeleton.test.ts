import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryListSkeleton } from "../src/components/StoryListSkeleton.tsx";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("the web story-list loader", () => {
  it("renders a status region with the caption and one placeholder per card", () => {
    const html = renderToStaticMarkup(createElement(StoryListSkeleton, { count: 4 }));
    assert.match(html, /role="status"/);
    assert.match(html, /Summoning your stories…/);
    assert.equal((html.match(/story-skeleton-card/g) ?? []).length, 4);
  });

  it("staggers the cards' entrance and caps the delay", () => {
    const html = renderToStaticMarkup(createElement(StoryListSkeleton, { count: 8 }));
    assert.match(html, /animation-delay:0ms/);
    assert.match(html, /animation-delay:110ms/);
    assert.match(html, /animation-delay:550ms/);
    assert.doesNotMatch(html, /animation-delay:660ms/, "the stagger stops after five cards");
  });

  it("takes a caption for other lists", () => {
    assert.match(renderToStaticMarkup(createElement(StoryListSkeleton, { caption: "Gathering the library…" })), /Gathering the library…/);
  });

  it("the placeholder cards are hidden from assistive tech, so the status is announced once", () => {
    const html = renderToStaticMarkup(createElement(StoryListSkeleton, { count: 2 }));
    assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 2);
  });
});

describe("the web Admin list and the refresh label", () => {
  it("Admin shows the shared loader while loading, and keeps its error and empty branches", () => {
    const admin = readFileSync(path.join(webRoot, "src/pages/Admin.tsx"), "utf8");
    assert.match(admin, /!stories && <StoryListSkeleton caption="Gathering the stories…" \/>/);
    assert.match(admin, /No finished stories yet\./);
    assert.match(admin, /\{error && <p className="error">\{error\}<\/p>\}/);
  });

  it("My Stories shows a Refreshing label only over a list already on screen, and clears it when the request ends", () => {
    const page = readFileSync(path.join(webRoot, "src/pages/MyStories.tsx"), "utf8");
    assert.match(page, /\.finally\(\(\) => setRefreshing\(false\)\)/);
    assert.match(page, /\{refreshing && stories && \(/);
    assert.match(page, /Refreshing…/);
  });
});
