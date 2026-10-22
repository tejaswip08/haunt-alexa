import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { identityHeaders, type KeyValueStore } from "../src/lib/identity.ts";

const memory = (init: Record<string, string> = {}): KeyValueStore => {
  const data = { ...init };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe("identityHeaders", () => {
  it("sends the signed-in user's access token, in development and production", () => {
    for (const dev of [true, false]) assert.deepEqual(identityHeaders({ dev, token: "a.b.c" }), { Authorization: "Bearer a.b.c" });
  });

  it("is a guest (no identity headers) in production without sign-in", () => {
    assert.deepEqual(identityHeaders({ dev: false, local: memory() }), {});
  });

  it("keeps one stable development id per browser", () => {
    const local = memory();
    const first = identityHeaders({ dev: true, local, newId: () => "ABCDEF12-3456-7890" });
    assert.match(first["X-Haunt-Dev-User"]!, /^dev-[a-z0-9]{8,32}$/);
    assert.deepEqual(identityHeaders({ dev: true, local, newId: () => "zzzzzzzzzzzz" }), first);
  });

  it("survives storage that throws", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.match(identityHeaders({ dev: true, local: broken })["X-Haunt-Dev-User"]!, /^dev-/);
  });
});
