import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";

// Offline: mock story writer, temporary data folder, the development stand-in for sign-in.
const dataDir = await mkdtemp(path.join(tmpdir(), "haunt-guest-list-test-"));
Object.assign(process.env, { HAUNT_PROVIDER: "mock", HAUNT_AGENT: "mock", HAUNT_STORE: "file", HAUNT_DATA_DIR: dataDir, HAUNT_PREWRITE: "off" });
const { createHauntMcpServer } = await import("../src/mcp.ts");
const { createMcpRouter } = await import("../src/mcp-route.ts");
const { createRateLimiter } = await import("../src/rate-limit.ts");
const { meRouter } = await import("../src/me.ts");
const { devAuthenticator, identify } = await import("../src/auth.ts");

let base = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/me", identify(devAuthenticator), meRouter);
  app.use(
    "/api/mcp",
    createMcpRouter({
      access: { kind: "first-party" },
      createServer: createHauntMcpServer,
      authenticate: devAuthenticator,
      guests: { secure: false },
      limiter: createRateLimiter([{ windowMs: 60_000, max: 10_000 }]),
    }),
  );
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Starts a story; returns its id and the guest cookie the server set (if any). */
async function startStory(premise: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Haunt-Client": "web",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start_story", arguments: { premise } } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  const storyId = JSON.parse(line).result.structuredContent.storyId as string;
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("haunt_guest="))?.split(";")[0];
  return { storyId, cookie };
}

async function myStories(headers: Record<string, string>) {
  const res = await fetch(`${base}/api/me/stories`, { headers });
  return { status: res.status, body: (await res.json()) as { stories?: { storyId: string; status: string }[]; error?: string } };
}

describe("GET /api/me/stories for guests", () => {
  it("lists a guest's stories by their guest cookie, and no one else's", async () => {
    const first = await startStory("A lighthouse that blinks in morse");
    assert.ok(first.cookie, "the server gives a new guest a guest cookie");
    const second = await startStory("A doll that moves at night", { Cookie: first.cookie! });

    const mine = await myStories({ Cookie: first.cookie! });
    assert.equal(mine.status, 200);
    assert.deepEqual(new Set(mine.body.stories!.map((s) => s.storyId)), new Set([first.storyId, second.storyId]));

    // Another device (another guest cookie) sees only its own story.
    const other = await startStory("Footsteps in the attic");
    assert.ok(other.cookie && other.cookie !== first.cookie);
    assert.deepEqual((await myStories({ Cookie: other.cookie! })).body.stories!.map((s) => s.storyId), [other.storyId]);

    // A signed-in listener's stories never show up in a guest's list.
    const user = { "X-Haunt-Dev-User": "dev-listtester01" };
    const owned = await startStory("A signed-in story", user);
    assert.deepEqual((await myStories(user)).body.stories!.map((s) => s.storyId), [owned.storyId]);
    assert.ok(!(await myStories({ Cookie: first.cookie! })).body.stories!.some((s) => s.storyId === owned.storyId));
  });

  it("gives an empty list without a guest cookie", async () => {
    const res = await myStories({});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stories, []);
  });

  it("keeps every other /api/me route for signed-in listeners", async () => {
    const { storyId, cookie } = await startStory("A guest who wants to publish");
    const submit = await fetch(`${base}/api/me/stories/${storyId}/submit`, {
      method: "POST",
      headers: { Cookie: cookie!, "Content-Type": "application/json" },
      body: JSON.stringify({ creator: "Guest", summary: "Should not be allowed" }),
    });
    assert.equal(submit.status, 401);
    assert.equal((await fetch(`${base}/api/me/guest-stories`, { headers: { Cookie: cookie! } })).status, 401);
  });
});
