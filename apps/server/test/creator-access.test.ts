import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { identify, type Authenticator } from "../src/auth.ts";
import { AccessError, CreatorAccessStore, createCreatorAccessRouter } from "../src/creator-access.ts";
import { ProfileStore, RoleConflictError } from "../src/profiles.ts";
import type { Role } from "../src/roles.ts";

// Creator access, against the real store and the real role middleware. The table is an in-memory stand-in that evaluates the
// condition and update expressions the store sends (including nested paths, AND/OR, and set ADD/DELETE), and applies a
// transaction all-or-nothing, as DynamoDB does. Nothing reaches DynamoDB, Cognito, or AWS.

const LISTENER = "11100000-0000-4000-8000-000000000001";
const LISTENER_2 = "11100000-0000-4000-8000-000000000002";
const CREATOR = "22200000-0000-4000-8000-000000000001";
const ADMIN = "33300000-0000-4000-8000-000000000001";
const ADMIN_2 = "33300000-0000-4000-8000-000000000002";
const NOBODY = "44400000-0000-4000-8000-000000000001";

type Row = Record<string, any>;

/** An in-memory table keyed by `userId`, with the expression subset this store uses. */
function fakeTable() {
  const rows = new Map<string, Row>();
  const hooks: { beforeTransact?: () => void; failNextTransact?: Error } = {};
  const reads = { transactions: 0 };

  const names = (input: Row, token: string) => (token.startsWith("#") ? input.ExpressionAttributeNames?.[token] ?? token : token);
  const valueOf = (input: Row, token: string) => {
    if (!(token in (input.ExpressionAttributeValues ?? {}))) throw new Error(`missing value ${token}`);
    return input.ExpressionAttributeValues[token];
  };
  const resolvePath = (input: Row, path: string) => path.split(".").map((part) => names(input, part));
  const get = (item: Row | undefined, path: string[]) => path.reduce<any>((node, key) => (node && typeof node === "object" ? node[key] : undefined), item);

  /** Condition: attribute_exists/attribute_not_exists, path = :value, with AND, OR, and parentheses. */
  function evaluate(input: Row, expression: string | undefined, item: Row | undefined): boolean {
    if (!expression) return true;
    const tokens = expression.match(/\(|\)|[#:\w.]+|=/g) ?? [];
    let at = 0;
    const peek = () => tokens[at];
    const take = () => tokens[at++];
    const expr = (): boolean => {
      let value = term();
      while (peek() === "OR") {
        take();
        value = term() || value;
      }
      return value;
    };
    const term = (): boolean => {
      let value = factor();
      while (peek() === "AND") {
        take();
        value = factor() && value;
      }
      return value;
    };
    const factor = (): boolean => {
      if (peek() === "(") {
        take();
        const value = expr();
        if (take() !== ")") throw new Error("unbalanced condition");
        return value;
      }
      const head = take();
      if (head === "attribute_exists" || head === "attribute_not_exists") {
        take(); // (
        const path = resolvePath(input, take());
        take(); // )
        const exists = get(item, path) !== undefined;
        return head === "attribute_exists" ? exists : !exists;
      }
      const path = resolvePath(input, head);
      if (take() !== "=") throw new Error("unsupported comparison");
      const want = valueOf(input, take());
      return get(item, path) === want;
    };
    const result = expr();
    if (at !== tokens.length) throw new Error(`unsupported condition: ${expression}`);
    return result;
  }

  /** Update: SET path = :value, ADD path :set, DELETE path :set. A missing parent path is an error, as in DynamoDB. */
  function applyUpdate(input: Row, expression: string, item: Row) {
    const clauses = expression.match(/(SET|ADD|DELETE)\s+[^]*?(?=\s(?:SET|ADD|DELETE)\s|$)/g) ?? [];
    for (const clause of clauses) {
      const keyword = clause.slice(0, clause.indexOf(" ")).trim();
      const body = clause.slice(keyword.length).trim();
      if (keyword === "SET") {
        for (const assignment of body.split(",")) {
          const [lhs, rhs] = assignment.split("=").map((s) => s.trim());
          write(item, resolvePath(input, lhs!), valueOf(input, rhs!));
        }
      } else {
        const [pathText, token] = body.split(/\s+/);
        const path = resolvePath(input, pathText!);
        const current: Set<string> = get(item, path) ?? new Set();
        const add = valueOf(input, token!) as Set<string>;
        const next = new Set(current);
        for (const value of add) keyword === "ADD" ? next.add(value) : next.delete(value);
        if (next.size === 0) remove(item, path);
        else write(item, path, next);
      }
    }
  }
  function parentOf(item: Row, path: string[]) {
    let node: any = item;
    for (const key of path.slice(0, -1)) {
      node = node?.[key];
      if (node === undefined) throw Object.assign(new Error("The document path provided in the update expression is invalid"), { name: "ValidationException" });
    }
    return node;
  }
  function write(item: Row, path: string[], value: unknown) {
    parentOf(item, path)[path[path.length - 1]!] = value;
  }
  function remove(item: Row, path: string[]) {
    delete parentOf(item, path)[path[path.length - 1]!];
  }

  const failCondition = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
  const cancelled = (reasons: string[]) =>
    Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons.map((Code) => ({ Code })) });

  const client = {
    send: async (command: { constructor: { name: string }; input: Row }) => {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "GetCommand") {
        const item = rows.get(input.Key.userId);
        return { Item: item ? structuredClone(item) : undefined };
      }
      if (name === "PutCommand") {
        const current = rows.get(input.Item.userId);
        if (!evaluate(input, input.ConditionExpression, current)) throw failCondition();
        rows.set(input.Item.userId, structuredClone(input.Item));
        return {};
      }
      if (name === "TransactWriteCommand") {
        if (hooks.failNextTransact) {
          const error = hooks.failNextTransact;
          hooks.failNextTransact = undefined;
          throw error;
        }
        hooks.beforeTransact?.();
        hooks.beforeTransact = undefined;
        reads.transactions += 1;
        // Check every condition against the current state first; then apply every write, or none.
        const reasons: string[] = [];
        for (const entry of input.TransactItems as Row[]) {
          const spec = entry.Put ?? entry.Update ?? entry.ConditionCheck;
          const current = rows.get(spec.Item?.userId ?? spec.Key.userId);
          reasons.push(evaluate(spec, spec.ConditionExpression, current) ? "None" : "ConditionalCheckFailed");
        }
        if (reasons.some((r) => r !== "None")) throw cancelled(reasons);
        const staged = new Map(Array.from(rows, ([k, v]) => [k, structuredClone(v)]));
        for (const entry of input.TransactItems as Row[]) {
          if (entry.ConditionCheck) continue; // checked above; writes nothing
          if (entry.Put) {
            staged.set(entry.Put.Item.userId, structuredClone(entry.Put.Item));
          } else {
            const key = entry.Update.Key.userId;
            const next = staged.get(key) ?? { userId: key };
            applyUpdate(entry.Update, entry.Update.UpdateExpression, next);
            staged.set(key, next);
          }
        }
        rows.clear();
        for (const [k, v] of staged) rows.set(k, v);
        return {};
      }
      throw new Error(`unsupported command ${name}`);
    },
  };
  return { rows, client, hooks, reads };
}

function harness() {
  const table = fakeTable();
  const profiles = new ProfileStore(table.client as never, "haunt-users");
  const access = new CreatorAccessStore(table.client as never, "haunt-users", profiles);
  return { ...table, profiles, access };
}

const rowsOf = (t: ReturnType<typeof harness>, sub: string) => t.rows.get(sub);
const requestOf = (t: ReturnType<typeof harness>, sub: string) => t.rows.get(`creator-request#${sub}`)?.request as Row | undefined;
const pendingIndex = (t: ReturnType<typeof harness>) => Array.from((t.rows.get("creator-pending")?.pending as Set<string>) ?? []);
const auditRows = (t: ReturnType<typeof harness>) => Array.from(t.rows.values()).filter((r) => typeof r.userId === "string" && r.userId.startsWith("audit#"));

describe("requesting Creator access (store)", () => {
  it("saves one PENDING request and adds the account to the pending index", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    const request = await t.access.request(LISTENER);
    assert.equal(request.status, "PENDING");
    assert.equal(request.subject, LISTENER);
    assert.equal(requestOf(t, LISTENER)?.status, "PENDING");
    assert.deepEqual(pendingIndex(t), [LISTENER]);
  });

  it("refuses a duplicate while a request is pending, and changes nothing", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.access.request(LISTENER);
    const before = structuredClone(requestOf(t, LISTENER));
    await assert.rejects(t.access.request(LISTENER), (error: AccessError) => error.status === 409);
    assert.deepEqual(requestOf(t, LISTENER), before);
    assert.deepEqual(pendingIndex(t), [LISTENER], "still one entry in the index");
  });

  it("allows a new request after a rejection", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.access.request(LISTENER);
    await t.access.reject(LISTENER, ADMIN);
    const again = await t.access.request(LISTENER);
    assert.equal(again.status, "PENDING");
    assert.deepEqual(pendingIndex(t), [LISTENER]);
  });

  it("refuses a request from an account that is not a LISTENER", async () => {
    const t = harness();
    await t.profiles.provisionRole(CREATOR, "CREATOR");
    await assert.rejects(t.access.request(CREATOR), (error: AccessError) => error.status === 409);
    assert.equal(requestOf(t, CREATOR), undefined, "no request was written");
  });

  it("creates a missing profile as a LISTENER before the request", async () => {
    const t = harness();
    const request = await t.access.request(NOBODY);
    assert.equal(request.status, "PENDING");
    assert.equal(rowsOf(t, NOBODY)?.role, "LISTENER");
  });
});

describe("deciding a request (store)", () => {
  it("approve makes the account a CREATOR, closes the request, clears the index, and writes one audit record", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.access.request(LISTENER);
    await t.access.approve(LISTENER, ADMIN, "Good first stories");
    assert.equal(rowsOf(t, LISTENER)?.role, "CREATOR");
    const request = requestOf(t, LISTENER)!;
    assert.equal(request.status, "APPROVED");
    assert.equal(request.decidedBy, ADMIN);
    assert.equal(request.reason, "Good first stories");
    assert.ok(request.decidedAt);
    assert.deepEqual(pendingIndex(t), []);
    const audit = auditRows(t);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.audit.actor, ADMIN);
    assert.equal(audit[0]!.audit.target, LISTENER);
    assert.equal(audit[0]!.audit.change, "creator-request APPROVED");
  });

  it("reject closes the request with a reason, leaves the account a LISTENER, and writes an audit record", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.access.request(LISTENER);
    await t.access.reject(LISTENER, ADMIN, "Not yet");
    assert.equal(rowsOf(t, LISTENER)?.role, "LISTENER", "no Creator permission was granted");
    assert.equal(requestOf(t, LISTENER)?.status, "REJECTED");
    assert.equal(requestOf(t, LISTENER)?.reason, "Not yet");
    assert.deepEqual(pendingIndex(t), []);
    assert.equal(auditRows(t).length, 1);
    assert.equal(auditRows(t)[0]!.audit.change, "creator-request REJECTED");
  });

  it("a second decision on the same request is refused and writes no second audit record", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.access.request(LISTENER);
    await t.access.approve(LISTENER, ADMIN);
    await assert.rejects(t.access.reject(LISTENER, ADMIN_2), (error: AccessError) => error.status === 409);
    await assert.rejects(t.access.approve(LISTENER, ADMIN_2), (error: AccessError) => error.status === 409);
    assert.equal(requestOf(t, LISTENER)?.status, "APPROVED");
    assert.equal(auditRows(t).length, 1);
  });

  it("refuses a decision on an account with no request", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await assert.rejects(t.access.approve(LISTENER, ADMIN), (error: AccessError) => error.status === 409);
    assert.equal(rowsOf(t, LISTENER)?.role, "LISTENER", "no role change without a request");
    assert.equal(auditRows(t).length, 0);
  });

  it("does not change the role when the account's role changed before the decision", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.access.request(LISTENER);
    // Another write moves the account to ADMIN between the request and the decision.
    t.hooks.beforeTransact = () => {
      t.rows.set(LISTENER, { ...t.rows.get(LISTENER)!, role: "ADMIN" });
    };
    await assert.rejects(t.access.approve(LISTENER, ADMIN), (error: AccessError) => error.status === 409);
    assert.equal(rowsOf(t, LISTENER)?.role, "ADMIN", "the other write stands; approval did not overwrite it");
    assert.equal(requestOf(t, LISTENER)?.status, "PENDING", "the request stayed pending: nothing was partly applied");
    assert.deepEqual(pendingIndex(t), [LISTENER]);
    assert.equal(auditRows(t).length, 0);
  });

  it("does not change the role when the profile is missing, and keeps the request pending", async () => {
    const t = harness();
    await t.access.request(NOBODY);
    t.rows.delete(NOBODY);
    await assert.rejects(t.access.approve(NOBODY, ADMIN), (error: AccessError) => error.status === 409);
    assert.equal(rowsOf(t, NOBODY), undefined, "no profile was created by the approval");
    assert.equal(requestOf(t, NOBODY)?.status, "PENDING");
  });

  it("a transaction that fails for another reason changes nothing and surfaces the fault", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.access.request(LISTENER);
    t.hooks.failNextTransact = Object.assign(new Error("connection reset"), { name: "InternalServerError" });
    await assert.rejects(t.access.approve(LISTENER, ADMIN), (error: Error) => error.name === "InternalServerError");
    assert.equal(rowsOf(t, LISTENER)?.role, "LISTENER");
    assert.equal(requestOf(t, LISTENER)?.status, "PENDING");
    assert.deepEqual(pendingIndex(t), [LISTENER]);
    assert.equal(auditRows(t).length, 0);
  });

  it("when two admins decide at once, exactly one succeeds", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.access.request(LISTENER);
    const results = await Promise.allSettled([t.access.approve(LISTENER, ADMIN), t.access.approve(LISTENER, ADMIN_2)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(auditRows(t).length, 1);
  });
});

describe("the pending list (store)", () => {
  it("lists only PENDING requests, newest first, with display details", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.profiles.provisionRole(LISTENER_2, "LISTENER");
    await t.access.request(LISTENER);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await t.access.request(LISTENER_2);
    await t.access.approve(LISTENER, ADMIN);
    const pending = await t.access.pending();
    assert.deepEqual(pending.map((r) => r.subject), [LISTENER_2]);
    assert.equal(pending[0]!.displayName, null);
    assert.equal(pending[0]!.email, null);
  });
});

describe("the Creator access routes", () => {
  let t: ReturnType<typeof harness>;
  let server: ReturnType<express.Application["listen"]>;
  let base = "";

  before(async () => {
    t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    await t.profiles.provisionRole(LISTENER_2, "LISTENER");
    await t.profiles.provisionRole(CREATOR, "CREATOR");
    await t.profiles.provisionRole(ADMIN, "ADMIN");
    await t.profiles.provisionRole(ADMIN_2, "ADMIN");
    // A stand-in authenticator: the caller is whoever the test names. Roles still come from the profile store.
    const authenticate: Authenticator = async (req) => {
      const sub = req.get("x-test-user");
      return sub ? { sub, admin: false } : undefined;
    };
    const app = express();
    app.use(express.json());
    app.use("/api/creator-access", identify(authenticate), createCreatorAccessRouter(t.access, t.profiles));
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const call = (who: string | undefined, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(who ? { "x-test-user": who } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("refuses anonymous callers on every route", async () => {
    assert.equal((await call(undefined, "GET", "/api/creator-access/me")).status, 401);
    assert.equal((await call(undefined, "POST", "/api/creator-access/me")).status, 401);
    assert.equal((await call(undefined, "GET", "/api/creator-access/admin/requests")).status, 401);
    assert.equal((await call(undefined, "POST", `/api/creator-access/admin/requests/${LISTENER}/approve`)).status, 401);
  });

  it("lets a LISTENER request access, and shows the status back to them", async () => {
    const created = await call(LISTENER, "POST", "/api/creator-access/me");
    assert.equal(created.status, 201);
    const mine = (await (await call(LISTENER, "GET", "/api/creator-access/me")).json()) as { request: Row };
    assert.equal(mine.request.status, "PENDING");
  });

  it("refuses a duplicate request with 409", async () => {
    assert.equal((await call(LISTENER, "POST", "/api/creator-access/me")).status, 409);
  });

  it("refuses a request from a CREATOR or ADMIN with 403, because the request is for LISTENERs only", async () => {
    assert.equal((await call(CREATOR, "POST", "/api/creator-access/me")).status, 403);
    assert.equal((await call(ADMIN, "POST", "/api/creator-access/me")).status, 403);
  });

  it("refuses LISTENERs and CREATORs the pending list, with 403", async () => {
    assert.equal((await call(LISTENER, "GET", "/api/creator-access/admin/requests")).status, 403);
    assert.equal((await call(CREATOR, "GET", "/api/creator-access/admin/requests")).status, 403);
  });

  it("lets an ADMIN read the pending list", async () => {
    const res = await call(ADMIN, "GET", "/api/creator-access/admin/requests");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { requests: Row[] };
    assert.deepEqual(body.requests.map((r) => r.subject), [LISTENER]);
  });

  it("refuses a LISTENER or CREATOR approving or rejecting any request, and leaves the role alone", async () => {
    for (const who of [LISTENER_2, CREATOR]) {
      assert.equal((await call(who, "POST", `/api/creator-access/admin/requests/${LISTENER}/approve`, {})).status, 403);
      assert.equal((await call(who, "POST", `/api/creator-access/admin/requests/${LISTENER}/reject`, {})).status, 403);
    }
    assert.equal(rowsOf(t, LISTENER)?.role, "LISTENER");
    assert.equal(requestOf(t, LISTENER)?.status, "PENDING");
  });

  it("refuses an admin deciding their own request, and a request whose owner tries to decide it", async () => {
    assert.equal((await call(ADMIN, "POST", `/api/creator-access/admin/requests/${ADMIN}/approve`, {})).status, 403);
    assert.equal((await call(LISTENER, "POST", `/api/creator-access/admin/requests/${LISTENER}/approve`, {})).status, 403);
  });

  it("rejects a malformed account id before touching the database", async () => {
    const reads = t.reads.transactions;
    assert.equal((await call(ADMIN, "POST", "/api/creator-access/admin/requests/not%20valid!/approve", {})).status, 400);
    assert.equal(t.reads.transactions, reads);
  });

  it("answers 409 for a request that does not exist", async () => {
    const res = await call(ADMIN, "POST", `/api/creator-access/admin/requests/${NOBODY}/approve`, {});
    assert.equal(res.status, 409);
  });

  it("lets an ADMIN reject, with the reason kept and trimmed to 280 characters", async () => {
    const res = await call(ADMIN, "POST", `/api/creator-access/admin/requests/${LISTENER}/reject`, { reason: `  ${"x".repeat(300)}  ` });
    assert.equal(res.status, 200);
    assert.equal(requestOf(t, LISTENER)?.status, "REJECTED");
    assert.equal(requestOf(t, LISTENER)?.reason.length, 280);
    assert.equal(rowsOf(t, LISTENER)?.role, "LISTENER");
  });

  it("after a rejection the listener may ask again, and an ADMIN's approval makes them a CREATOR", async () => {
    assert.equal((await call(LISTENER, "POST", "/api/creator-access/me")).status, 201);
    const res = await call(ADMIN_2, "POST", `/api/creator-access/admin/requests/${LISTENER}/approve`, {});
    assert.equal(res.status, 200);
    assert.equal(rowsOf(t, LISTENER)?.role, "CREATOR");
    assert.equal(requestOf(t, LISTENER)?.status, "APPROVED");
  });

  it("refuses a request from an account that is now a CREATOR", async () => {
    assert.equal((await call(LISTENER, "POST", "/api/creator-access/me")).status, 403);
  });

  it("answers a transaction fault with a generic 503, without internal detail", async () => {
    await call(LISTENER_2, "POST", "/api/creator-access/me");
    t.hooks.failNextTransact = Object.assign(new Error("ProvisionedThroughputExceeded at table haunt-users"), { name: "ProvisionedThroughputExceededException" });
    const res = await call(ADMIN, "POST", `/api/creator-access/admin/requests/${LISTENER_2}/approve`, {});
    assert.equal(res.status, 503);
    const body = await res.text();
    assert.doesNotMatch(body, /haunt-users|Throughput|table/i);
    assert.equal(requestOf(t, LISTENER_2)?.status, "PENDING");
  });
});

describe("the Creator role race", () => {
  it("refuses a request when the account became a CREATOR after the profile was read, and writes nothing", async () => {
    const t = harness();
    await t.profiles.provisionRole(LISTENER, "LISTENER");
    // The profile is LISTENER when the request starts; another write makes it CREATOR before the transaction commits.
    t.hooks.beforeTransact = () => {
      t.rows.set(LISTENER, { ...t.rows.get(LISTENER)!, role: "CREATOR" });
    };
    await assert.rejects(t.access.request(LISTENER), (error: AccessError) => error.status === 409);
    assert.equal(requestOf(t, LISTENER), undefined, "no request was written for a CREATOR");
    assert.deepEqual(pendingIndex(t), [], "the pending index is unchanged");
    assert.equal(rowsOf(t, LISTENER)?.role, "CREATOR", "the other write stands");
  });
});
