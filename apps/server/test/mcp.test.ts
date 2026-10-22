import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { authorizeStoryWrite } from "../src/story-write-access.ts";

// Offline and isolated: mock story writer, temporary data folder. Set before the server modules load.
const dataDir = await mkdtemp(path.join(tmpdir(), "haunt-mcp-test-"));
const ADMIN_USER = "admin-test-user";
Object.assign(process.env, { HAUNT_PROVIDER: "mock", HAUNT_AGENT: "mock", HAUNT_STORE: "file", HAUNT_DATA_DIR: dataDir, HAUNT_PREWRITE: "off" });
const { createHauntMcpServer } = await import("../src/mcp.ts");
const { createMcpRouter } = await import("../src/mcp-route.ts");
const { createRateLimiter } = await import("../src/rate-limit.ts");
const { adminRouter, setAdminProfiles } = await import("../src/admin.ts");

const TOKEN = "test-token-0123456789abcdef";
const TOKEN_B = "second-token-0123456789abcdef";
let base = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Named admin: the request carries a verified identity, and the admin's profile role is ADMIN. No shared token.
  const named = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const sub = req.get("x-test-user");
    if (sub) res.locals.user = { sub, admin: false };
    next();
  };
  setAdminProfiles({ get: async (sub: string) => ({ role: sub === ADMIN_USER ? "ADMIN" : "LISTENER" }) } as never);
  app.use("/api/admin", named, adminRouter);
  const roomy = () => createRateLimiter([{ windowMs: 60_000, max: 10_000 }]);
  app.use("/mcp", createMcpRouter({ access: { kind: "external", tokens: [TOKEN], production: true }, createServer: createHauntMcpServer, limiter: roomy() }));
  app.use("/mcp-two", createMcpRouter({ access: { kind: "external", tokens: [TOKEN, TOKEN_B], production: true }, createServer: createHauntMcpServer, limiter: roomy() }));
  app.use("/api/mcp-guests", createMcpRouter({ access: { kind: "first-party" }, guests: { secure: false }, createServer: createHauntMcpServer, limiter: roomy() }));
  app.use("/prod-closed", createMcpRouter({ access: { kind: "external", tokens: [], production: true }, createServer: createHauntMcpServer, limiter: roomy() }));
  app.use("/dev-open", createMcpRouter({ access: { kind: "external", tokens: [], production: false }, createServer: createHauntMcpServer, limiter: roomy() }));
  app.use("/api/mcp", createMcpRouter({ access: { kind: "first-party" }, createServer: createHauntMcpServer, limiter: roomy() }));
  // The first-party route with the real write-access rule (index.ts), and a test header standing in for the session.
  const gatedAuth = async (req: express.Request) => (req.get("x-test-user") ? { sub: req.get("x-test-user")!, admin: false } : undefined);
  app.use(
    "/api/mcp-gated",
    createMcpRouter({
      access: { kind: "first-party" },
      createServer: createHauntMcpServer,
      authenticate: gatedAuth,
      authorizeTool: (user, tool, external) => authorizeStoryWrite(user, tool, external, true),
      limiter: roomy(),
    }),
  );
  app.use("/limited", createMcpRouter({ access: { kind: "first-party" }, createServer: createHauntMcpServer, limiter: createRateLimiter([{ windowMs: 60_000, max: 2 }]) }));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** One JSON-RPC call over Streamable HTTP (stateless); parses JSON or a single SSE message. */
async function rpc(pathname: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const res = await fetch(base + pathname, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-11-25",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.startsWith("event:") || text.includes("\ndata:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return { status: res.status, body: data ? JSON.parse(data) : null, headers: res.headers };
}
const auth = { Authorization: `Bearer ${TOKEN}` };
const web = { "X-Haunt-Client": "web" };
const init = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } };

describe("MCP handshake and discovery", () => {
  it("initializes on 2025-11-25 and lists the six Haunt tools with the scene view", async () => {
    const hello = await rpc("/mcp", "initialize", init, auth);
    assert.equal(hello.status, 200);
    assert.equal(hello.body.result.protocolVersion, "2025-11-25");
    assert.equal(hello.body.result.serverInfo.name, "haunt");
    const tools = await rpc("/mcp", "tools/list", {}, auth);
    const names = tools.body.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, ["answer_story", "end_story", "list_library", "play_episode", "resume_story", "start_story"]);
    const start = tools.body.result.tools.find((t: { name: string }) => t.name === "start_story");
    assert.match(start._meta.ui.resourceUri, /^ui:\/\/haunt\/scene-/);
  });

  it("still accepts the 2025-03-26 protocol the Alexa+ client sends", async () => {
    const hello = await rpc("/mcp", "initialize", { ...init, protocolVersion: "2025-03-26" }, auth);
    assert.equal(hello.body.result.protocolVersion, "2025-03-26");
  });
});

describe("External /mcp authentication", () => {
  it("rejects missing and wrong tokens with 401 and a WWW-Authenticate header", async () => {
    const none = await rpc("/mcp", "tools/list");
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.equal((await rpc("/mcp", "tools/list", {}, { Authorization: "Bearer wrong-token-0000000000" })).status, 401);
    assert.equal((await rpc("/mcp", "tools/list", {}, { Authorization: TOKEN })).status, 401, "token without the Bearer scheme");
  });

  it("is closed in production when no token is configured, and open only in development", async () => {
    assert.equal((await rpc("/prod-closed", "tools/list", {}, auth)).status, 401);
    assert.equal((await rpc("/dev-open", "tools/list")).status, 200);
  });

  it("answers CORS preflight for browser-based MCP clients", async () => {
    const res = await fetch(base + "/mcp", { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  });
});

describe("Starting a story through MCP, by account", () => {
  const startStory = (headers: Record<string, string>) =>
    rpc("/api/mcp-gated", "tools/call", { name: "start_story", arguments: { premise: "A folk horror story.", length: "short" } }, { ...web, ...headers });

  it("lets a signed-in listener start a story (this was a 403 for every LISTENER)", async () => {
    const res = await startStory({ "x-test-user": "listener-account" });
    assert.equal(res.status, 200, "a signed-in listener is not refused");
    assert.ok(res.body.result?.structuredContent?.storyId, "the story is created and has an id");
  });

  it("refuses a production guest with no account, without saying why in detail", async () => {
    const res = await startStory({});
    assert.equal(res.status, 403);
  });
});

describe("First-party /api/mcp for Haunt's own pages", () => {
  it("accepts same-origin requests with Haunt's header and refuses everything else", async () => {
    assert.equal((await rpc("/api/mcp", "tools/list", {}, web)).status, 200);
    assert.equal((await rpc("/api/mcp", "tools/list")).status, 403, "no Haunt header");
    assert.equal((await rpc("/api/mcp", "tools/list", {}, { ...web, Origin: "https://evil.example" })).status, 403);
  });

  it("rate-limits and limits request size", async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await rpc("/limited", "tools/list", {}, web)).status);
    assert.deepEqual(statuses, [200, 200, 429]);
    const big = await fetch(base + "/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...web },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(300 * 1024) } }),
    });
    assert.equal(big.status, 413);
  });
});

describe("Stories through MCP", () => {
  it("takes the Create screen's sub-genre and refuses a malformed one", async () => {
    const ok = await rpc("/mcp", "tools/call", { name: "start_story", arguments: { premise: "A cult in the hills", subgenre: "cult", length: "short" } }, auth);
    assert.equal(ok.body.result.isError ?? false, false);
    assert.ok(ok.body.result.structuredContent.storyId);

    const bad = await rpc("/mcp", "tools/call", { name: "start_story", arguments: { premise: "A cult", subgenre: "Cult Story!", length: "short" } }, auth);
    assert.ok(bad.body.error || bad.body.result?.isError, "a malformed sub-genre is refused");
  });

  it("serves independent clients in parallel and resumes a story from a new connection", async () => {
    const started = await Promise.all(
      ["A lighthouse", "A hospital", "A train"].map((premise) =>
        rpc("/mcp", "tools/call", { name: "start_story", arguments: { premise, length: "short" } }, auth),
      ),
    );
    const ids = started.map((r) => r.body.result.structuredContent.storyId);
    assert.equal(new Set(ids).size, 3, "each client got its own story");

    // Same signed-in account and endpoint that started the story: a guest device cannot change a signed-in account's story.
    const answered = await rpc("/mcp", "tools/call", { name: "answer_story", arguments: { storyId: ids[0], answer: "Climb the stairs" } }, auth);
    assert.equal(answered.body.result.structuredContent.sceneNumber, 2);

    // A brand-new connection (stateless server) picks the story up where it left off.
    const resumed = await rpc("/mcp", "tools/call", { name: "resume_story", arguments: { storyId: ids[0] } }, auth);
    const scene = resumed.body.result.structuredContent;
    assert.equal(scene.sceneNumber, 2);
    assert.equal(scene.choicesSoFar.length, 1);
    assert.ok(scene.presentation?.setting, "scene presentation is included");
  });

  it("returns a safe tool error for an unknown story", async () => {
    const res = await rpc("/mcp", "tools/call", { name: "resume_story", arguments: { storyId: "st_doesnotexist0000" } }, auth);
    assert.equal(res.body.result.isError, true);
    assert.doesNotMatch(JSON.stringify(res.body), /at .*\.ts:\d+/, "no stack traces");
  });
});

describe("Library: publish, list and play", () => {
  it("lists a published story and plays it with artwork, without the listener's answers", async () => {
    const { engine, library } = await import("../src/stories.ts");
    let turn = await engine.start({ premise: "A lighthouse that lights itself", targetScenes: 3 });
    turn = await engine.decide(turn.story.id, "I climb the spiral stairs slowly");
    turn = await engine.finish(turn.story.id);
    await library.put({
      episode: await engine.episode(turn.story.id),
      creator: "Pen Name",
      summary: "A keeper who never left.",
      publishedAt: new Date().toISOString(),
    });

    const listed = await rpc("/api/mcp", "tools/call", { name: "list_library", arguments: {} }, web);
    const entry = listed.body.result.structuredContent.episodes.find((e: { storyId: string }) => e.storyId === turn.story.id);
    assert.equal(entry.creator, "Pen Name");

    const played = await rpc("/mcp", "tools/call", { name: "play_episode", arguments: { storyId: turn.story.id } }, auth);
    const episode = played.body.result.structuredContent;
    assert.equal(episode.kind, "episode");
    assert.equal(episode.segments.length, turn.story.scenes.length);
    for (const segment of episode.segments) {
      assert.ok(["lighthouse", "train", "hospital", "house", "forest", "water", "door", "figure"].includes(segment.presentation.setting));
      assert.ok(segment.presentation.effects.includes("scene_fade"));
    }
    const blob = JSON.stringify(episode);
    assert.ok(!blob.includes("I climb the spiral stairs slowly"), "answers never appear in an episode");
    for (const scene of turn.story.scenes) if (scene.question) assert.ok(!blob.includes(scene.question.prompt), "nor do questions");
  });

  it("returns a tool error for an episode that isn't in the library", async () => {
    const res = await rpc("/mcp", "tools/call", { name: "play_episode", arguments: { storyId: "st_notpublished00" } }, auth);
    assert.equal(res.body.result.isError, true);
  });
});

describe("Publishing is idempotent and duplicate-aware", () => {
  const admin = async (path: string, body?: unknown, who = ADMIN_USER) => {
    const res = await fetch(base + "/api/admin" + path, {
      method: body ? "POST" : "GET",
      headers: { "x-test-user": who, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const finished = async (premise: string, answer = "Go in") => {
    const { engine } = await import("../src/stories.ts");
    const { story } = await engine.start({ premise, targetScenes: 3 });
    await engine.decide(story.id, answer);
    return (await engine.finish(story.id)).story;
  };
  const libraryIds = async () => {
    const res = await rpc("/api/mcp", "tools/call", { name: "list_library", arguments: {} }, web);
    return res.body.result.structuredContent.episodes.map((e: { storyId: string }) => e.storyId) as string[];
  };

  it("requires a named ADMIN, and a listener is refused", async () => {
    assert.equal((await admin("/stories", undefined, "listener-user")).status, 403, "a LISTENER account");
    const res = await fetch(base + "/api/admin/stories", { headers: { Authorization: "Bearer wrong-token" } });
    assert.equal(res.status, 403, "a bearer secret with no signed-in account");
    assert.equal((await admin("/stories")).status, 200, "a named ADMIN account");
  });

  it("publishing the same story twice keeps one entry and updates it", async () => {
    const story = await finished("A radio that plays tomorrow's news");
    const first = await admin("/publish", { storyId: story.id, creator: "Pen", summary: "First summary" });
    assert.equal(first.body.action, "created");
    const { library } = await import("../src/stories.ts");
    const publishedAt = (await library.get(story.id))!.publishedAt;
    await new Promise((r) => setTimeout(r, 5));
    const second = await admin("/publish", { storyId: story.id, creator: "Pen", summary: "Better summary" });
    assert.equal(second.body.action, "updated");
    const entry = (await library.get(story.id))!;
    assert.equal(entry.summary, "Better summary");
    assert.equal(entry.publishedAt, publishedAt, "first publish date is kept");
    assert.ok(entry.updatedAt && entry.updatedAt > publishedAt);
    assert.equal((await libraryIds()).filter((id) => id === story.id).length, 1);
  });

  it("keeps different stories with the same title or premise, with a warning", async () => {
    // Same premise, different choices: two genuinely different stories.
    const a = await finished("The last train from an empty station", "Step closer");
    const b = await finished("The last train from an empty station", "Turn back");
    assert.notEqual(a.id, b.id);
    await admin("/publish", { storyId: a.id, creator: "Pen", summary: "One" });
    const second = await admin("/publish", { storyId: b.id, creator: "Pen", summary: "Two" });
    assert.equal(second.status, 200);
    assert.ok(second.body.warnings.some((w: { storyId: string }) => w.storyId === a.id), "warns about the look-alike");
    const ids = await libraryIds();
    assert.ok(ids.includes(a.id) && ids.includes(b.id), "both stories stay in the library");
    const listed = (await admin("/stories")).body.stories.find((s: { storyId: string }) => s.storyId === b.id);
    assert.ok(listed.similar.length > 0, "the admin list shows the warning before publishing too");
  });

  it("refuses identical narration under another id unless confirmed", async () => {
    const { engine } = await import("../src/stories.ts");
    const original = await finished("A mirror that remembers faces");
    await admin("/publish", { storyId: original.id, creator: "Pen", summary: "Original" });
    const copy = { ...structuredClone(original), id: "st_copyofmirror0001" };
    await engine.store.put(copy);
    const refused = await admin("/publish", { storyId: copy.id, creator: "Pen", summary: "Copy" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.duplicateOf, original.id);
    assert.ok(!(await libraryIds()).includes(copy.id));
    const forced = await admin("/publish", { storyId: copy.id, creator: "Pen", summary: "Copy", allowDuplicate: true });
    assert.equal(forced.body.action, "created");
  });
});

describe("Nine published stories", () => {
  it("are all listed once, each opens its own episode, and publishing others leaves them unchanged", async () => {
    const { engine, library } = await import("../src/stories.ts");
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      // Shared premises and titles on purpose: like the real library, they must stay separate.
      const { story } = await engine.start({ premise: i % 2 ? "A night shift in an abandoned hospital" : "The last train", targetScenes: 3 });
      await engine.decide(story.id, `Choice number ${i}`);
      await engine.finish(story.id);
      ids.push(story.id);
    }
    const res = await fetch(base + "/api/admin/publish", {
      method: "POST",
      headers: { "x-test-user": ADMIN_USER, "Content-Type": "application/json" },
      body: JSON.stringify({ storyId: ids[0], creator: "Pen", summary: "The first one" }),
    });
    assert.equal(res.status, 200);
    const before = structuredClone(await library.get(ids[0]!));
    for (const id of ids.slice(1)) {
      const r = await fetch(base + "/api/admin/publish", {
        method: "POST",
        headers: { "x-test-user": ADMIN_USER, "Content-Type": "application/json" },
        body: JSON.stringify({ storyId: id, creator: "Pen", summary: `Summary for ${id}` }),
      });
      assert.equal(r.status, 200, `publish ${id}`);
    }
    assert.deepEqual(await library.get(ids[0]!), before, "an existing entry is untouched by other publishes");

    const listed = (await rpc("/api/mcp", "tools/call", { name: "list_library", arguments: {} }, web)).body.result.structuredContent.episodes;
    const listedIds = listed.map((e: { storyId: string }) => e.storyId);
    for (const id of ids) assert.equal(listedIds.filter((x: string) => x === id).length, 1, `${id} listed exactly once`);

    for (const id of ids) {
      const ep = (await rpc("/api/mcp", "tools/call", { name: "play_episode", arguments: { storyId: id } }, web)).body.result.structuredContent;
      const source = await engine.get(id);
      assert.equal(ep.storyId, id);
      assert.equal(ep.title, source.title);
      assert.equal(ep.segments.length, source.scenes.length);
    }
  });
});

describe("Story ownership over external /mcp", () => {
  const A = { Authorization: `Bearer ${TOKEN}` };
  const B = { Authorization: `Bearer ${TOKEN_B}` };
  const ANSWER = "Climb the stairs";

  /** Starts a story with token A and returns its id. */
  async function startWithA(premise: string) {
    const r = await rpc("/mcp-two", "tools/call", { name: "start_story", arguments: { premise, length: "short" } }, A);
    return r.body.result.structuredContent.storyId as string;
  }
  const answer = (headers: Record<string, string>, storyId: string) =>
    rpc("/mcp-two", "tools/call", { name: "answer_story", arguments: { storyId, answer: ANSWER } }, headers);
  const resume = (headers: Record<string, string>, storyId: string) =>
    rpc("/mcp-two", "tools/call", { name: "resume_story", arguments: { storyId } }, headers);

  it("token A starts a story, answers it, and continues it", async () => {
    const id = await startWithA("A lighthouse keeper hears a knock");
    const answered = await answer(A, id);
    assert.equal(answered.body.result.isError, undefined);
    assert.equal(answered.body.result.structuredContent.sceneNumber, 2);
    const resumed = await resume(A, id);
    assert.equal(resumed.body.result.structuredContent.sceneNumber, 2);
    assert.equal(resumed.body.result.structuredContent.choicesSoFar.length, 1);
  });

  it("token B cannot answer, end, or resume token A's story, and A's story is unchanged", async () => {
    const id = await startWithA("A ferry that never docks");
    const answered = await answer(B, id);
    assert.equal(answered.body.result.isError, true);
    assert.match(answered.body.result.content[0].text, /no longer exists/);

    const ended = await rpc("/mcp-two", "tools/call", { name: "end_story", arguments: { storyId: id } }, B);
    assert.equal(ended.body.result.isError, true);
    const resumedByB = await resume(B, id);
    assert.equal(resumedByB.body.result.isError, true);

    const resumedByA = await resume(A, id);
    assert.equal(resumedByA.body.result.structuredContent.sceneNumber, 1, "B's refused answer changed nothing");
    assert.equal(resumedByA.body.result.structuredContent.choicesSoFar.length, 0);
  });

  it("requests with missing or invalid authentication cannot modify the story", async () => {
    const id = await startWithA("A church bell rings at midnight");
    const none = await answer({}, id);
    assert.equal(none.status, 401);
    const wrong = await answer({ Authorization: "Bearer not-a-real-token-0123456789" }, id);
    assert.equal(wrong.status, 401);
    const resumed = await resume(A, id);
    assert.equal(resumed.body.result.structuredContent.sceneNumber, 1);
    assert.equal(resumed.body.result.structuredContent.choicesSoFar.length, 0);
  });

  it("first-party /api ownership is unchanged: a guest's own cookie continues its story, another guest cannot", async () => {
    const web = { "X-Haunt-Client": "web" };
    const started = await rpc("/api/mcp-guests", "tools/call", { name: "start_story", arguments: { premise: "A guest story", length: "short" } }, web);
    const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^haunt_guest=/, "the first-party guest route issues a guest cookie");
    const id = started.body.result.structuredContent.storyId as string;

    const own = await rpc("/api/mcp-guests", "tools/call", { name: "answer_story", arguments: { storyId: id, answer: ANSWER } }, { ...web, Cookie: cookie });
    assert.equal(own.body.result.structuredContent.sceneNumber, 2);

    const noCookie = await rpc("/api/mcp-guests", "tools/call", { name: "answer_story", arguments: { storyId: id, answer: ANSWER } }, web);
    assert.equal(noCookie.body.result.isError, true);

    const other = await rpc("/api/mcp-guests", "tools/call", { name: "answer_story", arguments: { storyId: id, answer: ANSWER } }, { ...web, Cookie: "haunt_guest=" + "B".repeat(43) });
    assert.equal(other.body.result.isError, true);
  });

  it("the raw bearer token is never persisted or logged; only its hash is the owner key", async () => {
    const logged: string[] = [];
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const level of ["log", "info", "warn", "error"] as const) {
      console[level] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
    }
    let id = "";
    try {
      id = await startWithA("A secret that must stay secret");
      await answer(A, id);
    } finally {
      Object.assign(console, originals);
    }
    assert.ok(!logged.join("\n").includes(TOKEN), "the token must not appear in logs");

    let stored = "";
    for (const name of (await readdir(dataDir, { recursive: true })).map(String)) {
      try {
        stored += (await readFile(path.join(dataDir, name), "utf8")) + "\n";
      } catch {
        // a directory
      }
    }
    assert.ok(stored.includes(id), "the story was persisted");
    assert.ok(!stored.includes(TOKEN), "the raw token must not be persisted");
    const owner = createHash("sha256").update(`mcp-token:${TOKEN}`).digest("hex");
    assert.ok(stored.includes(owner), "the stored owner key is the hash of the token");
  });
});
