import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import serverlessExpress from "@codegenie/serverless-express";
import express from "express";
import { coverKey, coverPath, type CoverStorage } from "../src/covers.ts";
import { createCoverRouter } from "../src/user-stories-route.ts";

// The Lambda wrapper (serverless-express, default binary settings) must return image bytes as base64 with isBase64Encoded set,
// so API Gateway sends the raw bytes, and must leave JSON as plain text. Runs the real cover route through the real wrapper.

const OWNER = "8f1c2d3e-0000-4000-8000-00000000a11c";
const HAUNT = "us_abcdefghijklmnop";
const VIEWER = "8f1c2d3e-0000-4000-8000-00000000b0b0";

/** Every byte value, so any text conversion of the body would corrupt it. */
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

function appWith(objects: Map<string, Buffer>, status: "draft" | "published") {
  const storage: CoverStorage = {
    async presignUpload() {
      return { url: "https://bucket.example.test/", fields: {} };
    },
    async exists(key) {
      return objects.has(key);
    },
    async read(key) {
      const bytes = objects.get(key);
      return bytes ? Readable.from([bytes]) : undefined;
    },
  };
  const stories = {
    // The story's current cover is the object under test, so the route's "current cover" rule passes.
    get: async () => ({
      hauntId: HAUNT,
      userId: OWNER,
      status,
      publishedKey: status === "published" ? "published" : undefined,
      version: 1,
      story: { coverUrl: [...objects.keys()].map((k) => coverPath(k))[0] ?? "" },
    }),
  };
  const approvals = { get: async () => ({ status: "APPROVED" }) };
  const app = express();
  app.use((req, res, next) => {
    if (req.headers["x-test-user"] === VIEWER) res.locals.user = { sub: VIEWER, admin: false };
    next();
  });
  app.use("/api/covers", createCoverRouter({ storage, stories: stories as never, approvals: approvals as never, isAdmin: async () => false }));
  app.get("/api/json", (_req, res) => res.json({ ok: true, note: "text" }));
  app.get("/api/boom", (_req, res) => res.status(503).json({ error: "Cover images aren't available right now." }));
  return app;
}

function eventFor(path: string, headers: Record<string, string> = {}) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers,
    isBase64Encoded: false,
    requestContext: {
      http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "1",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      accountId: "1",
      apiId: "1",
      domainName: "example.test",
      domainPrefix: "example",
    },
  };
}

const context = { callbackWaitsForEmptyEventLoop: false, functionName: "test", awsRequestId: "1", getRemainingTimeInMillis: () => 1000 };

async function invoke(app: express.Application, path: string, headers: Record<string, string> = {}) {
  const handler = serverlessExpress({ app });
  return (await handler(eventFor(path, headers) as never, context as never, () => undefined)) as {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    isBase64Encoded: boolean;
  };
}

describe("Lambda wrapper: cover images come back as the exact bytes", () => {
  for (const [ext, type] of [["jpg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"]] as const) {
    it(`returns ${type} as base64 with isBase64Encoded, and the decoded body is the stored bytes`, async () => {
      const key = coverKey(OWNER, HAUNT, type);
      const stored = key.replace(/\.\w+$/, `.${ext}`);
      const objects = new Map([[stored, ALL_BYTES]]);
      const path = `/api/covers/${stored}`;
      const res = await invoke(appWith(objects, "published"), path);
      assert.equal(res.statusCode, 200);
      assert.equal(res.isBase64Encoded, true);
      assert.equal(res.headers["content-type"], type);
      assert.deepEqual(Buffer.from(res.body, "base64"), ALL_BYTES, "no byte was lost or re-encoded as text");
      assert.equal(res.headers["cache-control"], "private, no-store");
    });
  }

  it("returns a viewer's private cover the same way, for the owner's own draft", async () => {
    const stored = `covers/${OWNER}/${HAUNT}/0a1b2c3d-0000-4000-8000-000000000002.png`;
    const res = await invoke(appWith(new Map([[stored, ALL_BYTES]]), "draft"), `/api/covers/${stored}`, { "x-test-user": VIEWER });
    assert.equal(res.statusCode, 404, "another viewer cannot read a draft cover");
    assert.equal(res.isBase64Encoded, false);
  });
});

describe("Lambda wrapper: JSON and errors are unchanged", () => {
  it("returns JSON as plain text, not base64", async () => {
    const res = await invoke(appWith(new Map(), "draft"), "/api/json");
    assert.equal(res.isBase64Encoded, false);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(res.body), { ok: true, note: "text" });
  });

  it("returns an error as JSON with a generic message and no internal detail", async () => {
    const res = await invoke(appWith(new Map(), "draft"), "/api/boom");
    assert.equal(res.statusCode, 503);
    assert.equal(res.isBase64Encoded, false);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.doesNotMatch(res.body, /stack|at |bucket|Key|AccessDenied|\.ts:/i);
  });
});
