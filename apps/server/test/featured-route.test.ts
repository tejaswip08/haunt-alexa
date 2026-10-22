import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express, { type RequestHandler } from "express";
import { FeatureVersionError, type FeaturedEntry, type FeaturedStore } from "../src/featured.ts";
import { createFeaturedAdminRouter, createFeaturedPublicRouter } from "../src/featured-route.ts";

const NOW = Date.UTC(2026, 9, 22, 18);
const iso = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

/** A memory stand-in for the store, for the route tests only (the real store is tested against a fake DynamoDB). */
function store(initial: FeaturedEntry[] = [], failRead = false): FeaturedStore & { version: number } {
  const s = {
    entries: initial,
    version: 0,
    failRead,
    async read() {
      if (s.failRead) throw Object.assign(new Error("boom haunt-stats"), { name: "ProvisionedThroughputExceededException" });
      return { entries: s.entries, version: s.version };
    },
    async write(entries: FeaturedEntry[], expected: number) {
      if (expected !== s.version) throw new FeatureVersionError();
      s.entries = entries;
      s.version += 1;
      return s.version;
    },
  };
  return s;
}

const adminGate: RequestHandler = (req, res, next) => (req.get("x-admin") === "yes" ? next() : void res.status(403).json({ error: "Admins only." }));

describe("the public Featured Tonight read", () => {
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  let current: FeaturedStore;
  let enabled = true;
  const published = new Set(["live"]);

  before(async () => {
    const app = express();
    app.use(
      "/api/featured",
      createFeaturedPublicRouter({
        get enabled() {
          return enabled;
        },
        get store() {
          return current;
        },
        isPublished: async (id) => published.has(id),
        now: () => NOW,
      } as never),
    );
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("is off until the switch is on", async () => {
    enabled = false;
    current = store();
    assert.equal((await fetch(`${base}/api/featured`)).status, 503);
    enabled = true;
  });

  it("shows only active features whose story is still published, with a fallback when there are none", async () => {
    current = store([
      { storyId: "live", startsAt: iso(-1), endsAt: iso(2) },
      { storyId: "unpublished", startsAt: iso(-1), endsAt: iso(2) },
      { storyId: "live", startsAt: iso(5), endsAt: iso(9) },
    ]);
    const body = (await (await fetch(`${base}/api/featured`)).json()) as { features: { storyId: string }[]; fallback: boolean };
    assert.deepEqual(body.features.map((f) => f.storyId), ["live"]);
    assert.equal(body.fallback, false);
    current = store([{ storyId: "live", startsAt: iso(1), endsAt: iso(3) }]);
    const none = (await (await fetch(`${base}/api/featured`)).json()) as { features: unknown[]; fallback: boolean };
    assert.deepEqual(none.features, []);
    assert.equal(none.fallback, true);
  });

  it("answers a DynamoDB failure with a plain message", async () => {
    current = store([], true);
    const res = await fetch(`${base}/api/featured`);
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.doesNotMatch(text, /haunt-stats|Exceeded/);
  });
});

describe("the admin Featured Tonight writes", () => {
  let server: ReturnType<express.Application["listen"]>;
  let base = "";
  let current: FeaturedStore;
  const published = new Set(["live"]);

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/admin/featured",
      createFeaturedAdminRouter({
        enabled: true,
        get store() {
          return current;
        },
        isPublished: async (id) => published.has(id),
        adminOnly: adminGate,
        now: () => NOW,
      } as never),
    );
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const call = (method: string, path: string, body?: unknown, admin = true) =>
    fetch(`${base}/api/admin/featured${path}`, {
      method,
      headers: { "content-type": "application/json", ...(admin ? { "x-admin": "yes" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("refuses everyone who is not an admin, before reading or writing anything", async () => {
    current = store();
    assert.equal((await call("GET", "", undefined, false)).status, 403);
    assert.equal((await call("PUT", "", { storyId: "live", startsAt: iso(0), endsAt: iso(2), expectedVersion: 0 }, false)).status, 403);
    assert.equal((await call("DELETE", "/live?expectedVersion=0", undefined, false)).status, 403);
    assert.equal(current.version, 0, "nothing changed");
  });

  it("schedules a published story and returns the new version", async () => {
    current = store();
    const res = await call("PUT", "", { storyId: "live", startsAt: iso(0), endsAt: iso(2), expectedVersion: 0 });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { version: number; entries: FeaturedEntry[] };
    assert.equal(body.version, 1);
    assert.equal(body.entries[0]!.storyId, "live");
  });

  it("refuses a story that is not published, and an invalid window, with the reasons", async () => {
    current = store();
    const notPublished = await call("PUT", "", { storyId: "draft-story", startsAt: iso(0), endsAt: iso(2), expectedVersion: 0 });
    assert.equal(notPublished.status, 422);
    const invalid = await call("PUT", "", { storyId: "live", startsAt: iso(3), endsAt: iso(1), expectedVersion: 0 });
    assert.equal(invalid.status, 400);
    assert.match(((await invalid.json()) as { error: string }).error, /endsAt must be after startsAt/);
    assert.equal(current.version, 0);
  });

  it("refuses a missing or non-integer version, so an unversioned write can't overwrite", async () => {
    current = store();
    assert.equal((await call("PUT", "", { storyId: "live", startsAt: iso(0), endsAt: iso(2) })).status, 400);
    assert.equal((await call("PUT", "", { storyId: "live", startsAt: iso(0), endsAt: iso(2), expectedVersion: -1 })).status, 400);
  });

  it("answers a stale version with 409, so a second admin reloads instead of overwriting", async () => {
    current = store([], false);
    current.version = 4;
    const res = await call("PUT", "", { storyId: "live", startsAt: iso(0), endsAt: iso(2), expectedVersion: 2 });
    assert.equal(res.status, 409);
  });

  it("removes a selection by story id, with the version", async () => {
    current = store([{ storyId: "live", startsAt: iso(0), endsAt: iso(2) }]);
    const res = await call("DELETE", "/live?expectedVersion=0");
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { entries: unknown[] }).entries, []);
  });

  it("answers a DynamoDB failure on save with a plain message, and never claims it saved", async () => {
    const failing = store();
    failing.write = async () => {
      throw Object.assign(new Error("boom"), { name: "ProvisionedThroughputExceededException" });
    };
    current = failing;
    const res = await call("PUT", "", { storyId: "live", startsAt: iso(0), endsAt: iso(2), expectedVersion: 0 });
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as { error: string }).error, /couldn't be saved right now/);
  });
});
