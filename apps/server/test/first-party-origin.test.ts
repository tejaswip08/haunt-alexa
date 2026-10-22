import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFirstParty } from "../src/request-guards.ts";

/** Builds the request shape the server sees: `host` is what arrived at the server, `origin` what the browser sent. */
function req(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] } as unknown as Parameters<typeof isFirstParty>[0];
}

const WEB = { name: "x-haunt-client", value: "web" };
const API_HOST = "itok3jbqel.execute-api.us-east-1.amazonaws.com";
const VERCEL = "https://haunt-eight.vercel.app";

describe("first-party origin check", () => {
  it("accepts a same-host request from Haunt's own page", () => {
    assert.equal(isFirstParty(req({ host: API_HOST, origin: `https://${API_HOST}`, "x-haunt-client": "web" }), WEB), true);
  });

  it("accepts the production site through the Vercel rewrite when its origin is allowed", () => {
    // Vercel forwards /api to API Gateway, so Host is the API host while Origin is the site the user is on.
    const r = req({ host: API_HOST, origin: VERCEL, "x-haunt-client": "web" });
    assert.equal(isFirstParty(r, WEB, [VERCEL]), true);
  });

  it("refuses the same production origin when it is not in the allowlist", () => {
    const r = req({ host: API_HOST, origin: VERCEL, "x-haunt-client": "web" });
    assert.equal(isFirstParty(r, WEB, []), false);
  });

  it("refuses an unlisted origin even when the allowlist is set", () => {
    const r = req({ host: API_HOST, origin: "https://evil.example", "x-haunt-client": "web" });
    assert.equal(isFirstParty(r, WEB, [VERCEL]), false);
  });

  it("refuses a request without Haunt's header, whatever its origin", () => {
    const r = req({ host: API_HOST, origin: VERCEL });
    assert.equal(isFirstParty(r, WEB, [VERCEL]), false);
  });

  it("does not treat a lookalike suffix of an allowed origin as allowed", () => {
    const r = req({ host: API_HOST, origin: "https://haunt-eight.vercel.app.evil.example", "x-haunt-client": "web" });
    assert.equal(isFirstParty(r, WEB, [VERCEL]), false);
  });
});
