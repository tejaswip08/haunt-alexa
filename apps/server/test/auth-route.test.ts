import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

// Offline: a fake Cognito endpoint that signs real JWTs with a local key, mock story writer,
// temporary data folder. No AWS calls, no Bedrock or Polly.
const dataDir = await mkdtemp(path.join(tmpdir(), "haunt-auth-test-"));
Object.assign(process.env, { HAUNT_PROVIDER: "mock", HAUNT_AGENT: "mock", HAUNT_STORE: "file", HAUNT_DATA_DIR: dataDir, HAUNT_PREWRITE: "off" });
const { createAuthRouter } = await import("../src/auth-route.ts");
const { createCognitoClient } = await import("../src/cognito-client.ts");
const { cognitoAuthenticator, identify } = await import("../src/auth.ts");
const { meRouter } = await import("../src/me.ts");
const { createMcpRouter } = await import("../src/mcp-route.ts");
const { createHauntMcpServer } = await import("../src/mcp.ts");
const { createRateLimiter } = await import("../src/rate-limit.ts");

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_FAKE";
const CLIENT = "fake-client";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });

/** Just enough of Cognito's passwordless sign-in, with PreventUserExistenceErrors on. */
const fake = {
  users: new Map<string, { sub: string; confirmed: boolean; groups: string[] }>(),
  /** The last code "emailed" to each address. */
  codes: new Map<string, string>(),
  refresh: new Map<string, string>(),
  revoked: new Set<string>(),
  calls: [] as string[],
  wrongTries: 0,
  reset() {
    this.users.clear();
    this.codes.clear();
    this.refresh.clear();
    this.revoked.clear();
    this.calls = [];
    this.wrongTries = 0;
  },
};
let codeCounter = 10000000;
const mail = (email: string) => {
  const code = String(++codeCounter);
  fake.codes.set(email, code);
};
const fail = (res: express.Response, type: string) => res.status(400).json({ __type: type, message: type });

async function tokensFor(email: string, withRefresh = true) {
  const user = fake.users.get(email)!;
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setSubject(user.sub).setIssuer(ISSUER).setIssuedAt().setExpirationTime("1h").sign(privateKey);
  const refresh = `refresh-${user.sub}-${Math.random().toString(36).slice(2)}`;
  fake.refresh.set(refresh, email);
  return {
    AuthenticationResult: {
      AccessToken: await sign({ token_use: "access", client_id: CLIENT, "cognito:groups": user.groups }),
      IdToken: await sign({ token_use: "id", aud: CLIENT, email }),
      ...(withRefresh ? { RefreshToken: refresh } : {}),
      ExpiresIn: 3600,
    },
  };
}

const cognitoApp = express();
cognitoApp.use(express.json({ type: "application/x-amz-json-1.1" }));
cognitoApp.post("/", async (req, res) => {
  const op = String(req.get("x-amz-target")).split(".")[1]!;
  fake.calls.push(op);
  const body = req.body;
  if (body.ClientId !== CLIENT) return fail(res, "ResourceNotFoundException");
  const email = body.Username ?? body.AuthParameters?.USERNAME ?? body.ChallengeResponses?.USERNAME;
  switch (op) {
    case "SignUp":
      if (fake.users.has(email)) return fail(res, "UsernameExistsException");
      fake.users.set(email, { sub: `sub-${fake.users.size + 1}`, confirmed: false, groups: email.startsWith("admin") ? ["haunt-admins"] : [] });
      mail(email);
      return res.json({ UserConfirmed: false });
    case "ResendConfirmationCode":
      mail(email);
      return res.json({});
    case "ConfirmSignUp":
      if (body.ConfirmationCode !== fake.codes.get(email)) return fail(res, "CodeMismatchException");
      fake.users.get(email)!.confirmed = true;
      fake.codes.delete(email);
      return res.json({ Session: `confirmed:${email}` });
    case "InitiateAuth": {
      if (body.AuthFlow === "REFRESH_TOKEN_AUTH") {
        const token = body.AuthParameters.REFRESH_TOKEN;
        const owner = fake.refresh.get(token);
        if (!owner || fake.revoked.has(token)) return fail(res, "NotAuthorizedException");
        return res.json(await tokensFor(owner, false));
      }
      if (body.Session === `confirmed:${email}`) return res.json(await tokensFor(email));
      const user = fake.users.get(email);
      if (user && !user.confirmed) return fail(res, "UserNotConfirmedException");
      // Unknown users get a challenge too, so callers can't tell who has an account.
      if (user) mail(email);
      return res.json({ ChallengeName: "EMAIL_OTP", Session: `otp:${email}` });
    }
    case "RespondToAuthChallenge": {
      const code = fake.codes.get(email);
      if (!code || body.Session !== `otp:${email}`) return fail(res, "NotAuthorizedException");
      if (body.ChallengeResponses.EMAIL_OTP_CODE === "99999999") return fail(res, "ExpiredCodeException");
      if (body.ChallengeResponses.EMAIL_OTP_CODE !== code) return fail(res, "CodeMismatchException");
      fake.codes.delete(email);
      return res.json(await tokensFor(email));
    }
    case "RevokeToken":
      fake.revoked.add(body.Token);
      return res.json({});
  }
  fail(res, "UnknownOperationException");
});

let base = "";
let servers: ReturnType<express.Express["listen"]>[] = [];
const listen = async (app: express.Express) => {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

before(async () => {
  const endpoint = (await listen(cognitoApp)) + "/";
  const authenticate = cognitoAuthenticator({ issuer: ISSUER, clientId: CLIENT, adminGroup: "haunt-admins", keys: jwks });
  const app = express();
  app.use(express.json());
  app.use(
    "/api/auth",
    createAuthRouter({
      cognito: createCognitoClient({ region: "us-east-1", clientId: CLIENT, endpoint }),
      secureCookies: true,
      adminGroup: "haunt-admins",
      limits: { perIp: createRateLimiter([{ windowMs: 60_000, max: 10_000 }]), perEmail: createRateLimiter([{ windowMs: 60_000, max: 3 }]) },
    }),
  );
  app.use("/off/api/auth", createAuthRouter({ cognito: undefined, secureCookies: true, adminGroup: "haunt-admins" }));
  app.use("/api/me", identify(authenticate), meRouter);
  app.use(
    "/api/mcp",
    createMcpRouter({
      access: { kind: "first-party" },
      createServer: createHauntMcpServer,
      authenticate,
      guests: { secure: false },
      limiter: createRateLimiter([{ windowMs: 60_000, max: 10_000 }]),
    }),
  );
  base = await listen(app);
});
after(async () => {
  servers.forEach((s) => s.close());
  await rm(dataDir, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

/** A browser: keeps cookies (path-aware enough for /api and /api/auth) and Haunt's header. */
class Browser {
  cookies = new Map<string, { value: string; path: string; raw: string }>();
  token: string | undefined;

  async send(pathname: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = [...this.cookies.entries()]
      .filter(([, c]) => pathname.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join("; ");
    const res = await fetch(base + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-Haunt-Client": "web",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Protocol-Version": "2025-11-25",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split("; ");
      const [name, ...value] = pair!.split("=");
      const pathAttr = attrs.find((a) => a.startsWith("Path="))?.slice(5) ?? "/";
      if (attrs.includes("Max-Age=0")) this.cookies.delete(name!);
      else this.cookies.set(name!, { value: value.join("="), path: pathAttr, raw });
    }
    const text = await res.text();
    const json = text.startsWith("event:") || text.includes("\ndata:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
    return { status: res.status, headers: res.headers, text, body: json ? JSON.parse(json) : {} };
  }

  async signUp(email: string) {
    assert.equal((await this.send("/api/auth/start", { email, mode: "signup" })).status, 200);
    return this.enterCode(email);
  }

  async signIn(email: string) {
    assert.equal((await this.send("/api/auth/start", { email, mode: "signin" })).status, 200);
    return this.enterCode(email);
  }

  async enterCode(email: string) {
    const result = await this.send("/api/auth/verify", { code: fake.codes.get(email) ?? "00000000" });
    if (result.body.accessToken) this.token = result.body.accessToken;
    return result;
  }

  async tool(name: string, args: Record<string, unknown>) {
    const result = await this.send("/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const r = result.body.result;
    return r?.isError ? { error: r.content[0].text as string } : { scene: r?.structuredContent as { storyId: string } };
  }
}

describe("Email code sign-in", () => {
  it("answers 404 until a user pool is configured, and refuses other sites", async () => {
    const browser = new Browser();
    assert.equal((await browser.send("/off/api/auth/start", { email: "a@example.com", mode: "signin" })).status, 404);
    assert.equal((await browser.send("/api/auth/start", { email: "a@example.com", mode: "signin" }, { "X-Haunt-Client": "" })).status, 403);
    assert.equal((await browser.send("/api/auth/start", { email: "a@example.com", mode: "signin" }, { Origin: "https://evil.example" })).status, 403);
  });

  it("creates an account with one emailed code, and the token it gets passes the server's verification", async () => {
    const browser = new Browser();
    const done = await browser.signUp("reader@example.com");
    assert.equal(done.status, 200);
    assert.equal(done.body.user.email, "reader@example.com");
    assert.equal(done.body.user.admin, false);
    assert.ok(!("refreshToken" in done.body), "the refresh token never reaches page scripts");
    const refresh = browser.cookies.get("haunt_session")!;
    for (const flag of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/api/auth"]) assert.ok(refresh.raw.includes(flag), flag);
    // The cookie is an opaque session id, never a Cognito refresh token.
    assert.ok(![...fake.refresh.keys()].includes(decodeURIComponent(refresh.value)), "the cookie holds no Cognito token");
    assert.equal(done.headers.get("cache-control"), "no-store");
    assert.equal((await browser.send("/api/me/stories")).status, 200);
    assert.ok(!fake.calls.includes("RespondToAuthChallenge"), "confirming signs in without a second code");
  });

  it("says the same thing whether or not an email has an account", async () => {
    await new Browser().signUp("taken@example.com");
    const newcomer = await new Browser().send("/api/auth/start", { email: "new@example.com", mode: "signup" });
    const existing = await new Browser().send("/api/auth/start", { email: "taken@example.com", mode: "signup" });
    const unknown = await new Browser().send("/api/auth/start", { email: "nobody@example.com", mode: "signin" });
    // A new account is confirmed with a code of any length (null); a sign-in code is always 8 digits.
    assert.deepEqual([newcomer.status, newcomer.body], [200, { ok: true, next: "code", codeLength: null }]);
    assert.deepEqual([existing.status, existing.body], [200, { ok: true, next: "code", codeLength: null }]);
    assert.deepEqual([unknown.status, unknown.body], [200, { ok: true, next: "code", codeLength: 8 }]);
    // The existing account got a sign-in code instead, and it works.
    const again = new Browser();
    await again.send("/api/auth/start", { email: "taken@example.com", mode: "signup" });
    assert.equal((await again.enterCode("taken@example.com")).status, 200);
    // An unknown email can't be signed in, whatever code is tried.
    const ghost = new Browser();
    await ghost.send("/api/auth/start", { email: "nobody@example.com", mode: "signin" });
    const denied = await ghost.send("/api/auth/verify", { code: "12345678" });
    assert.equal(denied.status, 400);
    assert.match(denied.body.error, /didn't work|isn't right/);
    assert.doesNotMatch(denied.body.error, /account|registered|exist/i);
  });

  it("explains wrong and expired codes, and starts over after an expired one", async () => {
    await new Browser().signUp("returning@example.com");
    const browser = new Browser();
    await browser.send("/api/auth/start", { email: "returning@example.com", mode: "signin" });
    const wrong = await browser.send("/api/auth/verify", { code: "00000000" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /isn't right/);
    assert.equal((await browser.send("/api/auth/verify", { code: "12" })).body.error, "Enter the 8-digit code from the email.");
    const expired = await browser.send("/api/auth/verify", { code: "99999999" });
    assert.match(expired.body.error, /expired/);
    assert.equal(expired.body.restart, true);
    assert.equal(browser.cookies.has("haunt_signin"), false, "the attempt is cleared");
    assert.equal((await browser.send("/api/auth/verify", { code: "12345678" })).body.restart, true);
  });

  it("accepts only 8-digit sign-in codes; 6- and 7-digit codes never reach Cognito", async () => {
    await new Browser().signUp("eightdigit@example.com");
    const browser = new Browser();
    await browser.send("/api/auth/start", { email: "eightdigit@example.com", mode: "signin" });
    const before = fake.calls.filter((call) => call === "RespondToAuthChallenge").length;
    for (const code of ["123456", "1234567"]) {
      const refused = await browser.send("/api/auth/verify", { code });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error, "Enter the 8-digit code from the email.");
    }
    assert.equal(fake.calls.filter((call) => call === "RespondToAuthChallenge").length, before, "no Cognito call for a bad length");
    const wrong = await browser.send("/api/auth/verify", { code: "00000000" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /isn't right/);
    assert.equal(fake.calls.filter((call) => call === "RespondToAuthChallenge").length, before + 1);
  });

  it("accepts an autofilled code with spaces or invisible characters, and still refuses a code with a dash or a missing digit", async () => {
    // Each attempt uses its own email, so the per-email code limit never applies to this test.
    const signIn = async (email: string) => {
      await new Browser().signUp(email);
      const browser = new Browser();
      assert.equal((await browser.send("/api/auth/start", { email, mode: "signin" })).status, 200);
      return { browser, code: fake.codes.get(email)! };
    };
    const shapes: Array<(c: string) => string> = [
      (c) => `${c.slice(0, 4)} ${c.slice(4)}`,
      (c) => `${c.slice(0, 4)}\u00a0${c.slice(4)}`,
      (c) => `\u200b${c}\u200b`,
    ];
    for (const [index, shape] of shapes.entries()) {
      const { browser, code } = await signIn(`autofill-${index}@example.com`);
      const accepted = await browser.send("/api/auth/verify", { code: shape(code) });
      assert.equal(accepted.status, 200, JSON.stringify(shape(code)));
      assert.ok(accepted.body.accessToken);
    }
    // Only whitespace and invisible characters are removed here; a dash is not part of a Cognito code.
    const { browser, code } = await signIn("autofill-refused@example.com");
    const dashed = await browser.send("/api/auth/verify", { code: `${code.slice(0, 4)}-${code.slice(4)}` });
    assert.equal(dashed.status, 400);
    assert.equal(dashed.body.error, "Enter the 8-digit code from the email.");
    const short = await browser.send("/api/auth/verify", { code: `${code.slice(0, 4)} ${code.slice(4, 7)}` });
    assert.equal(short.status, 400);
    assert.equal(short.body.error, "Enter the 8-digit code from the email.");
    assert.equal(fake.codes.has("autofill-refused@example.com"), true, "refused codes never reach Cognito, so the code is still live");
  });

  it("accepts Android-style pastes with a left-to-right mark and a trailing line break", async () => {
    const lrm = String.fromCharCode(0x200e);
    const email = "android-paste@example.com";
    await new Browser().signUp(email);
    const browser = new Browser();
    assert.equal((await browser.send("/api/auth/start", { email, mode: "signin" })).status, 200);
    const code = fake.codes.get(email)!;
    const accepted = await browser.send("/api/auth/verify", { code: `${code.slice(0, 4)}${lrm}${code.slice(4)}\n` });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.body.accessToken);
  });

  it("keeps one browser's sign-in attempt to that browser: another browser can't verify with its code", async () => {
    const email = "cross-browser@example.com";
    await new Browser().signUp(email);
    const owner = new Browser();
    assert.equal((await owner.send("/api/auth/start", { email, mode: "signin" })).status, 200);
    const code = fake.codes.get(email)!;
    const stranger = new Browser();
    const refused = await stranger.send("/api/auth/verify", { code });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.restart, true, "a browser with no attempt of its own is told to start over");
    assert.equal(fake.codes.has(email), true, "the stranger's attempt never reached Cognito, so the code is still live");
    assert.equal((await owner.send("/api/auth/verify", { code })).status, 200, "the owner's own attempt still works");
  });

  it("lets only one of two simultaneous submits of the same code through", async () => {
    const email = "double-submit@example.com";
    await new Browser().signUp(email);
    const browser = new Browser();
    assert.equal((await browser.send("/api/auth/start", { email, mode: "signin" })).status, 200);
    const code = fake.codes.get(email)!;
    const answers = await Promise.all([browser.send("/api/auth/verify", { code }), browser.send("/api/auth/verify", { code })]);
    assert.equal(answers.filter((answer) => answer.status === 200).length, 1, "one submit signs in");
    assert.equal(answers.filter((answer) => answer.status !== 200).length, 1, "the other is refused, not sent to Cognito again");
    assert.equal(fake.calls.filter((call) => call === "RespondToAuthChallenge").length, 1, "Cognito saw the code once");
  });

  it("resends the confirmation code to an account that was never confirmed", async () => {
    await new Browser().send("/api/auth/start", { email: "halfway@example.com", mode: "signup" });
    const browser = new Browser();
    await browser.send("/api/auth/start", { email: "halfway@example.com", mode: "signin" });
    assert.ok(fake.calls.includes("ResendConfirmationCode"));
    assert.equal((await browser.enterCode("halfway@example.com")).status, 200);
  });

  it("limits codes per email", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await new Browser().send("/api/auth/start", { email: "spam@example.com", mode: "signin" })).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });

  it("renews from the refresh cookie, and signing out revokes it", async () => {
    const browser = new Browser();
    await browser.signUp("keeper@example.com");
    browser.token = undefined;
    const renewed = await browser.send("/api/auth/refresh", {});
    assert.equal(renewed.status, 200);
    browser.token = renewed.body.accessToken;
    assert.equal((await browser.send("/api/me/stories")).status, 200);
    // The token from sign-up (the fake also mints one per renewal; the server holds the first).
    const issued = [...fake.refresh].filter(([, email]) => email === "keeper@example.com").slice(0, 1).map(([token]) => token);
    assert.equal((await browser.send("/api/auth/signout", {})).status, 200);
    assert.ok(issued.length > 0 && issued.every((token) => fake.revoked.has(token)), "signing out revokes the Cognito token");
    assert.equal(browser.cookies.has("haunt_session"), false);
    assert.equal((await browser.send("/api/auth/refresh", {})).status, 401);
  });

  it("ends the session when Cognito refuses the refresh token", async () => {
    const browser = new Browser();
    await browser.signUp("stale@example.com");
    for (const token of fake.refresh.keys()) fake.revoked.add(token);
    const result = await browser.send("/api/auth/refresh", {});
    assert.deepEqual([result.status, result.body], [401, { signedIn: false, expired: true }]);
    assert.equal(browser.cookies.has("haunt_session"), false);
  });

  it("flags admins from their Cognito group, for the page's links only", async () => {
    assert.equal((await new Browser().signUp("admin@example.com")).body.user.admin, true);
  });
});

describe("Guest stories", () => {
  it("keep a guest's stories to that browser, and move them into an account only from it", async () => {
    const guest = new Browser();
    const opening = await guest.tool("start_story", { premise: "A guest's story", length: "short" });
    const storyId = opening.scene!.storyId;
    assert.ok(guest.cookies.get("haunt_guest")!.raw.includes("HttpOnly"));
    assert.ok((await guest.tool("resume_story", { storyId })).scene, "same browser can continue");
    const stranger = new Browser();
    assert.match((await stranger.tool("resume_story", { storyId })).error ?? "", /no longer exists/, "another browser can't, even with the id");

    // A different account, in another browser, can't claim it.
    const other = new Browser();
    await other.signUp("other@example.com");
    assert.equal((await other.send("/api/me/guest-stories")).body.count, 0);
    assert.equal((await other.send("/api/me/claim-guest-stories", {})).body.claimed, 0);

    // The guest signs up in the same browser and keeps the story.
    await guest.signUp("guest@example.com");
    assert.equal((await guest.send("/api/me/guest-stories")).body.count, 1);
    assert.ok((await guest.tool("resume_story", { storyId })).scene, "still reachable before claiming");
    assert.equal((await guest.send("/api/me/claim-guest-stories", {})).body.claimed, 1);
    assert.equal(guest.cookies.has("haunt_guest"), false, "a fresh guest key next time");
    const mine = (await guest.send("/api/me/stories")).body.stories;
    assert.deepEqual(mine.map((s: { storyId: string }) => s.storyId), [storyId]);
    assert.equal((await guest.send("/api/me/claim-guest-stories", {})).body.claimed, 0, "only once");
    assert.deepEqual((await other.send("/api/me/stories")).body.stories, []);

    // Signed out, the story is the account's: the browser's guest identity no longer reaches it.
    guest.token = undefined;
    assert.match((await guest.tool("resume_story", { storyId })).error ?? "", /no longer exists/);
  });

  it("never claims without a signed-in account", async () => {
    const guest = new Browser();
    await guest.tool("start_story", { premise: "Unclaimed", length: "short" });
    assert.equal((await guest.send("/api/me/claim-guest-stories", {})).status, 401);
  });
});
