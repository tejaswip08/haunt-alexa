import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createMockProvider, createStoryEngine } from "@firetales/core";
import { createSettingsGenerator, segmentsOf } from "../src/story-regenerate.ts";
import { publicRevisionOf, StoryInputSchema, UserStoryStore } from "../src/user-stories.ts";
import { StoryApprovalStore } from "../src/story-approvals.ts";
import { createCreatorStoryRouter } from "../src/user-stories-route.ts";
import { fakeDynamo, STORIES, APPROVALS } from "./support/fake-dynamo.ts";

// Regenerating a My Stories draft from its sub-genre settings, against the real stores (in-memory DynamoDB stand-in)
// and the real story engine (mock writer, so no model calls).
const ROLES: Record<string, string> = { alice: "CREATOR", bob: "LISTENER", admin: "ADMIN" };
const authenticate = async (req: express.Request) => {
  const sub = req.get("x-test-user");
  return sub && sub in ROLES ? { sub, admin: false } : undefined;
};
const profiles = { get: async (sub: string) => (sub in ROLES ? { role: ROLES[sub] } : undefined) } as never;
const settings = { subgenre: "folk", length: "short", fear: "scary", language: "en", idea: "" };
const PREMISE = "A folk horror story. Old rituals, smiling villagers, and a harvest that needs you.";

let server: ReturnType<express.Application["listen"]>;
let base = "";
let stories: UserStoryStore;
let approvals: StoryApprovalStore;

before(async () => {
  const dynamo = fakeDynamo();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 22, 9, 0, tick++)).toISOString();
  stories = new UserStoryStore(dynamo.client as never, STORIES, now);
  approvals = new StoryApprovalStore(dynamo.client as never, APPROVALS, STORIES, stories, now);
  const generate = createSettingsGenerator(createStoryEngine({ provider: createMockProvider() }));
  const app = express();
  app.use(express.json());
  app.use(
    "/api/me/user-stories",
    createCreatorStoryRouter({ authenticate, profiles, store: stories, limiter: { hit: () => ({ ok: true }) } as never, approvals, generate }),
  );
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const call = (user: string | undefined, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const draftInput = (title: string) =>
  StoryInputSchema.parse({ title, author: "Ada", segments: [{ sceneIndex: 0, narration: "The door opens.", ending: true }] });
/** A draft made in Create: it carries the settings it was generated from, so it can be regenerated. */
const generatedInput = (title: string) => StoryInputSchema.parse({ ...draftInput(title), settings });

describe("the settings generator", () => {
  it("writes a play-through that ends, with each question as a choice and every scene in order", async () => {
    const generate = createSettingsGenerator(createStoryEngine({ provider: createMockProvider() }));
    const result = await generate({ ...settings, length: "standard" } as never, PREMISE);
    assert.ok(result.title.length > 0);
    assert.equal(result.segments.length, 6, "standard is six scenes");
    result.segments.forEach((segment, index) => assert.equal(segment.sceneIndex, index));
    assert.equal(result.segments.at(-1)!.ending, true);
    assert.ok(result.segments.slice(0, -1).every((segment) => segment.next === segment.sceneIndex + 1));
  });

  it("turns a question and its suggestions into a choice that leads to the next scene", () => {
    const segments = segmentsOf({
      id: "st_x", title: "T", config: { premise: "p", genre: "g", language: "en", intensity: "scary", audience: "general", targetScenes: 2 },
      status: "active", phase: "opening", world: "", characters: [], facts: [], decisions: [],
      scenes: [
        { index: 0, narration: "A", mood: "calm", soundCues: [], visualPrompt: "a house", question: { prompt: "Go in?", suggestions: ["Enter", "Wait"] } },
        { index: 1, narration: "B", mood: "threat", soundCues: [], visualPrompt: "a door", ending: true },
      ],
      createdAt: "", updatedAt: "",
    } as never);
    assert.deepEqual(segments[0]!.choices, { prompt: "Go in?", options: [{ label: "Enter", next: 1 }, { label: "Wait", next: 1 }] });
    assert.equal(segments[1]!.ending, true);
  });
});

describe("regenerating a My Stories draft", () => {
  it("keeps the approved copy live, saves the new draft, and keeps the settings", async () => {
    const created = await stories.create("alice", generatedInput("The Approved Harvest"));
    const sub = await approvals.submit("alice", created.hauntId);
    await approvals.approve("admin", sub.submissionId);
    const approved = publicRevisionOf((await stories.get("alice", created.hauntId))!)!;
    assert.equal(approved.story.title, "The Approved Harvest");

    const res = await call("alice", "POST", `/api/me/user-stories/${created.hauntId}/regenerate`, { expectedVersion: approved.version, premise: PREMISE, settings });
    assert.equal(res.status, 200, await res.clone().text());
    const { story } = (await res.json()) as { story: { version: number; story: { settings: unknown; title: string } } };
    assert.equal(story.story.settings && (story.story.settings as typeof settings).subgenre, "folk");
    assert.notEqual(story.story.title, "The Approved Harvest", "the working draft is the new story");

    const after = await stories.get("alice", created.hauntId);
    assert.equal(after!.hauntId, created.hauntId, "the story keeps its id");
    assert.equal(after!.userId, "alice", "and its owner");
    assert.equal(publicRevisionOf(after!)!.story.title, "The Approved Harvest", "Community still shows the approved version");
    assert.equal(after!.publishedKey, "published", "the approved listing is not withdrawn by the edit");
  });

  it("refuses a regeneration based on an old version, so a stale tab can't overwrite newer work", async () => {
    const created = await stories.create("alice", generatedInput("Stale"));
    const res = await call("alice", "POST", `/api/me/user-stories/${created.hauntId}/regenerate`, { expectedVersion: 99, premise: PREMISE, settings });
    assert.equal(res.status, 409);
  });

  it("refuses to regenerate a hand-written story, so its scenes are never replaced", async () => {
    const created = await stories.create("alice", draftInput("Written by hand"));
    const res = await call("alice", "POST", `/api/me/user-stories/${created.hauntId}/regenerate`, { expectedVersion: 1, premise: PREMISE, settings });
    assert.equal(res.status, 422);
    assert.equal((await stories.get("alice", created.hauntId))!.story.segments[0]!.narration, "The door opens.");
  });

  it("lets only the owner regenerate: another user gets 404 for the same story", async () => {
    const created = await stories.create("alice", draftInput("Private"));
    const res = await call("bob", "POST", `/api/me/user-stories/${created.hauntId}/regenerate`, { expectedVersion: 1, premise: PREMISE, settings });
    assert.equal(res.status, 404);
  });

  it("refuses settings outside the canonical sub-genres, lengths and fear levels", async () => {
    const created = await stories.create("alice", draftInput("Bad settings"));
    const res = await call("alice", "POST", `/api/me/user-stories/${created.hauntId}/regenerate`, {
      expectedVersion: 1,
      premise: PREMISE,
      settings: { ...settings, subgenre: "romance" },
    });
    assert.equal(res.status, 400);
  });

  it("lets a listener regenerate their own draft, but not submit it", async () => {
    const created = await stories.create("bob", generatedInput("Bob's draft"));
    const regen = await call("bob", "POST", `/api/me/user-stories/${created.hauntId}/regenerate`, { expectedVersion: 1, premise: PREMISE, settings });
    assert.equal(regen.status, 200);
    const submit = await call("bob", "POST", `/api/me/user-stories/${created.hauntId}/submit`);
    assert.equal(submit.status, 403);
  });

  it("lists the regenerated draft in the owner's My Stories", async () => {
    const res = await call("alice", "GET", "/api/me/user-stories");
    assert.equal(res.status, 200);
    const { stories: list } = (await res.json()) as { stories: { userId: string }[] };
    assert.ok(list.length > 0);
    assert.ok(list.every((story) => story.userId === "alice"));
  });
});
