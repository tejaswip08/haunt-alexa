import { createHash, randomBytes, randomInt } from "node:crypto";
import { decodeJwt } from "jose";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { CognitoError, type CognitoClient, type CognitoTokens, type Step } from "./cognito-client.ts";
import { clearCookie, readCookie, setCookie } from "./cookies.ts";
import { createRateLimiter, type RateLimiter } from "./rate-limit.ts";
import { isFirstParty } from "./request-guards.ts";
import type { SharedLimiter } from "./otp-limits.ts";
import type { ProfileStore } from "./profiles.ts";
import { RoleConflictError } from "./profiles.ts";
import { isDevIdentity, type DevIdentity } from "./dev-identities.ts";
import { normalizeCode } from "./code-input.ts";

/**
 * Passwordless sign-in for Haunt's own pages, with email one-time codes from Cognito.
 *
 *   POST /start   {email, mode}  emails a code (sign in, or create an account)
 *   POST /verify  {code}         checks it; returns an access token and sets the refresh cookie
 *   POST /refresh                a fresh access token from the refresh cookie
 *   POST /signout                revokes the refresh token and clears the cookies
 *
 * TVs sign in with a phone instead ("scan to sign in", like the OAuth device flow):
 *
 *   POST /device/start               TV: a secret device code, a short user code for the phone
 *   POST /device/approve {userCode}  phone, signed in and confirmed by the listener: approves the TV
 *   POST /device/decline {userCode}  phone: the listener cancelled; the TV's code is void
 *   POST /device/cancel {deviceCode} TV: cancelled; the pairing is void
 *   POST /device/poll {deviceCode}   TV, every few seconds: pending, approved, expired, cancelled
 *
 * Approving never copies the phone's tokens to the TV. The server gives the TV its own opaque
 * session (its own HttpOnly cookie) for the same verified account, and keeps the Cognito tokens
 * on the server only. Signing out on either device revokes the Cognito session for both.
 * Sessions and pending device codes live in this process's memory: fine for one server, not for several.
 *
 * The session cookie holds an opaque id, never a Cognito token. The short-lived access token is
 * returned to the page, which keeps it in memory. Responses never say whether an email has an account.
 */

const REFRESH_COOKIE = "haunt_session";
const PENDING_COOKIE = "haunt_signin";
const COOKIE_PATH = "/api/auth";
const REFRESH_DAYS = 30;
/**
 * How long this browser keeps its pending sign-in. Cognito's built-in code expires on Cognito's
 * own schedule, and the sign-in session ends with it, so this cookie only lets the page find the
 * open session. It doesn't extend the code's life.
 */
const PENDING_SECONDS = 10 * 60;

export interface AuthRouteOptions {
  /** Development only: signs in one of the two local identities, provisioning its role first. Undefined outside isolated mock mode. */
  devSignIn?: (identity: DevIdentity) => Promise<CognitoTokens>;
  /** Development only: signs in the fixed local test user. Undefined everywhere except isolated mock mode. */
  devTestLogin?: () => Promise<CognitoTokens>;
  /** Undefined when no user pool is configured: every route then answers 404. */
  cognito: CognitoClient | undefined;
  secureCookies: boolean;
  /** Shown to the page only to decide which links to show; the server checks the group itself. */
  adminGroup: string;
  extraOrigins?: string[];
  /** Public site address for the TV's QR link; defaults to the address the TV used. */
  publicUrl?: string;
  /** Overrides for tests. */
  limits?: { perIp?: RateLimiter; perEmail?: RateLimiter; perPoll?: RateLimiter };
  /** Limits shared by every server instance (DynamoDB, otp-limits.ts). Unset in development. */
  shared?: SharedLimiter;
  /** Profiles in `haunt-users`, created at first sign-in. Unset in development. */
  profiles?: ProfileStore;
}

/** A verified account, held on the server. Its Cognito refresh token never leaves the server. */
interface Account {
  refreshToken: string;
  email: string | null;
  admin: boolean;
  expiresAt: number;
}

interface DeviceGrant {
  userCode: string;
  expiresAt: number;
  cancelled?: boolean;
  /** Set once a signed-in phone approves; the TV's poll turns it into the TV's own session. */
  account?: Account;
  /** True while a poll is confirming the approval with Cognito. Other polls wait (pending) instead of reading it as expired. */
  redeeming?: boolean;
}

interface Pending {
  email: string;
  /** "confirm": a new account's confirmation code; "signin": a sign-in code; "none": no such account (said nothing). */
  kind: "confirm" | "signin" | "none";
  session?: string;
}

const EmailSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  mode: z.enum(["signin", "signup"]),
});
/** Cognito's built-in passwordless sign-in code has eight digits for this pool (not configurable). */
export const SIGN_IN_CODE_DIGITS = 8;
/** A typed, pasted or autofilled code, normalized by the same rule the mobile page uses (code-input.ts), then checked as digits. */
const CodeSchema = z.object({
  code: z
    .string()
    .transform(normalizeCode)
    .pipe(z.string().regex(/^\d{6,8}$/)),
});
/** Verifications in progress, by email. A second request for the same email waits for the first instead of sending its code too. */
const verifying = new Set<string>();
const UserCodeSchema = z.object({ userCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/) });
const DeviceCodeSchema = z.object({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

const DEVICE_SECONDS = 10 * 60;
const DEVICE_POLL_SECONDS = 2;
/** No vowels (no accidental words) and no 0/O or 1/I mix-ups. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
const newUserCode = () => {
  const pick = () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${Array.from({ length: 4 }, pick).join("")}-${Array.from({ length: 4 }, pick).join("")}`;
};
const normalizeUserCode = (code: string) => (code.includes("-") ? code : `${code.slice(0, 4)}-${code.slice(4)}`);

/** The listener-facing wording for each Cognito failure. Nothing here reveals whether an account exists. */
function failure(error: unknown): { status: number; error: string; restart?: boolean } {
  const code = error instanceof CognitoError ? error.code : "";
  switch (code) {
    case "CodeMismatchException":
      return { status: 400, error: "That code isn't right. Check the latest email and try again." };
    case "ExpiredCodeException":
      return { status: 400, error: "That code has expired. Ask for a new one.", restart: true };
    case "NotAuthorizedException":
      // Also what an email without an account gets, so the wording mustn't hint at either.
      return { status: 400, error: "That code didn't work. Ask for a new one.", restart: true };
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
    case "CodeDeliveryFailureException":
      return { status: 429, error: "Too many attempts. Wait a few minutes, then try again." };
    case "InvalidParameterException":
      // Cognito rejects the request when the app client or pool isn't set up for the custom flow.
      // The email's format is checked before Cognito is ever called (EmailSchema), so this is never a typo.
      console.error("[auth] Cognito rejected the sign-in request: check the app client's auth flows and the pool's triggers.");
      return { status: 503, error: "Sign-in codes aren't set up on this server yet. Try again later." };
    default:
      // Log the kind of failure only: never emails, codes or tokens.
      console.error("[auth] Cognito call failed:", code || (error as Error)?.name);
      return { status: 502, error: "Sign-in isn't available right now. Try again in a moment." };
  }
}

const emailKey = (email: string) => createHash("sha256").update(email).digest("hex");

/** What the page may know about the signed-in user. Decoded, not verified: these come straight from Cognito. */
function sessionView(tokens: CognitoTokens, adminGroup: string) {
  const access = decodeJwt(tokens.accessToken);
  const id = tokens.idToken ? decodeJwt(tokens.idToken) : {};
  const groups = access["cognito:groups"];
  return {
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    user: {
      email: typeof id.email === "string" ? id.email : null,
      admin: Array.isArray(groups) && groups.includes(adminGroup),
    },
  };
}

export function createAuthRouter(options: AuthRouteOptions): Router {
  const router = Router();
  const cookie = { path: COOKIE_PATH, secure: options.secureCookies };
  const perIp = options.limits?.perIp ?? createRateLimiter([{ windowMs: 60_000, max: 20 }, { windowMs: 3_600_000, max: 120 }]);
  // Each code is an email someone receives: keep that from being used to flood an inbox.
  const perEmail = options.limits?.perEmail ?? createRateLimiter([{ windowMs: 15 * 60_000, max: 5 }, { windowMs: 86_400_000, max: 20 }]);
  // A waiting TV polls every couple of seconds, which the general limit would soon block.
  const perPoll = options.limits?.perPoll ?? createRateLimiter([{ windowMs: 60_000, max: 90 }, { windowMs: 3_600_000, max: 1_200 }]);
  /** Pending TV sign-ins by device code (the TV's secret), and the short code phones type. */
  const devices = new Map<string, DeviceGrant>();
  const deviceByUserCode = new Map<string, string>();
  /** Open sessions by their opaque id (the cookie's value). */
  const sessions = new Map<string, Account>();

  router.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    if (!options.cognito) return void res.status(404).json({ error: "Sign-in isn't set up on this server." });
    // Same-origin only, so other sites can't drive sign-in or refresh with the user's cookies.
    if (!isFirstParty(req, { name: "x-haunt-client", value: "web" }, options.extraOrigins)) {
      return void res.status(403).json({ error: "This endpoint is for Haunt's own pages." });
    }
    const limit = (req.path === "/device/poll" ? perPoll : perIp).hit(req.ip ?? "unknown");
    if (!limit.ok) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      return void res.status(429).json({ error: "Too many attempts. Wait a few minutes, then try again." });
    }
    next();
  });

  const cognito = () => options.cognito!;

  const savePending = (res: Response, pending: Pending) =>
    setCookie(res, PENDING_COOKIE, Buffer.from(JSON.stringify(pending)).toString("base64url"), { ...cookie, maxAgeSeconds: PENDING_SECONDS });

  function readPending(req: Request): Pending | undefined {
    try {
      const value = JSON.parse(Buffer.from(readCookie(req, PENDING_COOKIE) ?? "", "base64url").toString("utf8")) as Pending;
      return typeof value.email === "string" && ["confirm", "signin", "none"].includes(value.kind) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Opens a server-side session for an account and gives this browser only its opaque id. */
  function startSession(res: Response, account: Account) {
    pruneSessions();
    const sid = randomBytes(32).toString("base64url");
    sessions.set(sid, account);
    setCookie(res, REFRESH_COOKIE, sid, { ...cookie, maxAgeSeconds: REFRESH_DAYS * 86_400 });
  }

  function accountFrom(tokens: CognitoTokens): Account {
    const view = sessionView(tokens, options.adminGroup);
    if (!tokens.refreshToken) throw new CognitoError("NotAuthorizedException", "No refresh token to keep the session");
    return {
      refreshToken: tokens.refreshToken,
      email: view.user.email,
      admin: view.user.admin,
      expiresAt: Date.now() + REFRESH_DAYS * 86_400_000,
    };
  }

  /**
   * Creates the listener's profile on first sign-in, keyed by Cognito's `sub`. Never overwrites, and
   * never blocks the sign-in: if it fails, the next profile read creates it.
   */
  async function recordProfile(tokens: CognitoTokens) {
    if (!options.profiles) return;
    try {
      const id = decodeJwt(tokens.idToken ?? tokens.accessToken) as { sub?: unknown; email?: unknown; email_verified?: unknown };
      if (typeof id.sub !== "string") return;
      const verified = id.email_verified === true || id.email_verified === "true";
      const email = verified && typeof id.email === "string" ? id.email : null;
      await options.profiles.ensure(id.sub, email);
    } catch (error) {
      console.error("[auth] profile not created at sign-in:", (error as Error).name);
    }
  }

  async function signedIn(res: Response, tokens: CognitoTokens) {
    startSession(res, accountFrom(tokens));
    clearCookie(res, PENDING_COOKIE, cookie);
    await recordProfile(tokens);
    res.json({ ok: true, ...sessionView(tokens, options.adminGroup) });
  }

  /** The account behind this browser's session cookie, if it is still open. */
  function sessionOf(req: Request): { sid: string; account: Account } | undefined {
    const sid = readCookie(req, REFRESH_COOKIE);
    const account = sid ? sessions.get(sid) : undefined;
    if (!sid || !account) return undefined;
    if (account.expiresAt <= Date.now()) {
      sessions.delete(sid);
      return undefined;
    }
    return { sid, account };
  }

  function pruneSessions(now = Date.now()) {
    for (const [sid, account] of sessions) if (account.expiresAt <= now) sessions.delete(sid);
  }

  /** Ends every session that shares this Cognito refresh token (one account, one token). */
  function dropSessionsFor(refreshToken: string) {
    for (const [sid, account] of sessions) if (account.refreshToken === refreshToken) sessions.delete(sid);
  }

  function forgetExpiredDevices(now = Date.now()) {
    for (const [deviceCode, grant] of devices) {
      if (grant.expiresAt <= now) {
        devices.delete(deviceCode);
        deviceByUserCode.delete(grant.userCode);
      }
    }
  }

  /** Start sign-in for an existing account; a never-confirmed account gets its confirmation code again. */
  async function startSignIn(email: string): Promise<Pending> {
    try {
      const step = await cognito().startSignIn(email);
      return step.kind === "code" ? { email, kind: "signin", session: step.session } : { email, kind: "none" };
    } catch (error) {
      const code = (error as CognitoError).code;
      if (code === "UserNotFoundException") return { email, kind: "none" };
      if (code === "UserNotConfirmedException") {
        await cognito().resendConfirmation(email);
        return { email, kind: "confirm" };
      }
      throw error;
    }
  }

  router.post("/start", async (req, res) => {
    const parsed = EmailSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "That doesn't look like an email address." });
    const { email, mode } = parsed.data;
    const limit = perEmail.hit(emailKey(email));
    if (!limit.ok) return void res.status(429).json({ error: "Too many codes for this email. Wait a few minutes, then try again." });
    if (options.shared) {
      // Shared across every server instance (otp-limits.ts). Fails closed: no code is sent if the check can't run.
      try {
        const checks = await Promise.all([
          options.shared.hit(`email:${emailKey(email)}`, 5, 15 * 60),
          options.shared.hit(`email-day:${emailKey(email)}`, 20, 24 * 3600),
          options.shared.hit(`ip:${req.ip ?? "unknown"}`, 20, 60),
        ]);
        const denied = checks.find((check) => !check.ok);
        if (denied) {
          res.setHeader("Retry-After", String(denied.retryAfterSeconds));
          return void res.status(429).json({ error: "Too many codes for this email. Wait a few minutes, then try again." });
        }
      } catch (error) {
        console.error("[auth] shared sign-in limit check failed:", (error as Error).name);
        return void res.status(503).json({ error: "Sign-in is busy right now. Try again in a moment." });
      }
    }
    try {
      let pending: Pending;
      if (mode === "signup") {
        try {
          await cognito().signUp(email);
          pending = { email, kind: "confirm" };
        } catch (error) {
          // Already registered: sign them in instead, and say the same thing either way.
          if ((error as CognitoError).code !== "UsernameExistsException") throw error;
          pending = await startSignIn(email);
        }
      } else {
        pending = await startSignIn(email);
      }
      savePending(res, pending);
      // Sign-in codes have eight digits. Sign-up confirmation codes come from Cognito, so the length is
      // null: the page accepts six to eight digits and Cognito decides. Returned by mode, not by account,
      // so the response doesn't reveal whether an account exists.
      res.json({ ok: true, next: "code", codeLength: mode === "signup" ? null : SIGN_IN_CODE_DIGITS });
    } catch (error) {
      const { status, error: message } = failure(error);
      res.status(status).json({ error: message });
    }
  });

  // Development only. Answers 404 unless index.ts supplied devTestLogin (isolated mock mode, local DynamoDB).
  router.post("/dev-test-login", async (_req, res) => {
    if (!options.devTestLogin) return void res.status(404).json({ error: "Not found." });
    await signedIn(res, await options.devTestLogin());
  });

  // Development only. Answers 404 unless index.ts supplied devSignIn. Accepts exactly the two identity names, nothing else.
  router.post("/dev-login", async (req, res) => {
    if (!options.devSignIn) return void res.status(404).json({ error: "Not found." });
    const identity = req.body?.identity;
    if (!isDevIdentity(identity)) return void res.status(400).json({ error: "Choose Listener or Admin." });
    try {
      await signedIn(res, await options.devSignIn(identity));
    } catch (error) {
      if (error instanceof RoleConflictError) return void res.status(409).json({ error: error.message });
      throw error;
    }
  });

  router.post("/verify", async (req, res) => {
    const pending = readPending(req);
    if (!pending) return void res.status(400).json({ error: "This sign-in attempt has expired. Ask for a new code.", restart: true });
    const parsed = CodeSchema.safeParse(req.body);
    // Sign-in codes are exactly SIGN_IN_CODE_DIGITS. Sign-up confirmation codes are Cognito's own, so only
    // the digits are checked here; Cognito verifies the code itself. Nothing is truncated or padded.
    const expectedLength = pending.kind === "confirm" ? null : SIGN_IN_CODE_DIGITS;
    if (!parsed.success || (expectedLength !== null && parsed.data.code.length !== expectedLength)) {
      return void res.status(400).json({
        error: expectedLength ? `Enter the ${expectedLength}-digit code from the email.` : "Enter the code from the email.",
      });
    }
    const { code } = parsed.data;
    if (verifying.has(pending.email)) {
      return void res.status(409).json({ error: "This code is already being checked. Wait a moment, then try again." });
    }
    verifying.add(pending.email);
    try {
      if (pending.kind === "none") throw new CognitoError("CodeMismatchException", "no account");
      let step: Step;
      if (pending.kind === "confirm") {
        const session = await cognito().confirmSignUp(pending.email, code);
        // The confirmation session can sign the new account in without a second code, when Cognito offers it.
        step = await cognito().startSignIn(pending.email, session);
      } else {
        step = await cognito().answerCode(pending.email, pending.session ?? "", code);
      }
      if (step.kind === "code") {
        savePending(res, { email: pending.email, kind: "signin", session: step.session });
        return void res.json({ ok: true, next: "code", message: "Check your email for a sign-in code." });
      }
      await signedIn(res, step.tokens);
    } catch (error) {
      const result = failure(error);
      if (result.restart) clearCookie(res, PENDING_COOKIE, cookie);
      res.status(result.status).json({ error: result.error, ...(result.restart ? { restart: true } : {}) });
    } finally {
      verifying.delete(pending.email);
    }
  });

  router.post("/refresh", async (req, res) => {
    const current = sessionOf(req);
    if (!current) {
      clearCookie(res, REFRESH_COOKIE, cookie);
      return void res.status(401).json({ signedIn: false });
    }
    try {
      const tokens = await cognito().refresh(current.account.refreshToken);
      // Cognito rarely rotates the refresh token; keep whichever one it currently accepts.
      current.account.refreshToken = tokens.refreshToken ?? current.account.refreshToken;
      res.json({ ok: true, ...sessionView(tokens, options.adminGroup) });
    } catch (error) {
      const code = (error as CognitoError).code;
      if (code === "NotAuthorizedException") {
        // Revoked, expired or from another pool: the session is over.
        sessions.delete(current.sid);
        clearCookie(res, REFRESH_COOKIE, cookie);
        return void res.status(401).json({ signedIn: false, expired: true });
      }
      const { status, error: message } = failure(error);
      res.status(status).json({ error: message });
    }
  });

  router.post("/signout", async (req, res) => {
    const current = sessionOf(req);
    clearCookie(res, REFRESH_COOKIE, cookie);
    clearCookie(res, PENDING_COOKIE, cookie);
    if (current) {
      const { refreshToken } = current.account;
      // Ends every session of this account on this server (phone and any TV paired from it),
      // then revokes the Cognito token. Signing out locally still works if the revoke fails.
      dropSessionsFor(refreshToken);
      await cognito().revoke(refreshToken).catch((error) => console.error("[auth] revoke failed:", (error as Error).name));
    }
    res.json({ ok: true });
  });

  router.post("/device/start", (req, res) => {
    forgetExpiredDevices();
    const deviceCode = randomBytes(32).toString("base64url");
    let userCode = newUserCode();
    while (deviceByUserCode.has(userCode)) userCode = newUserCode();
    devices.set(deviceCode, { userCode, expiresAt: Date.now() + DEVICE_SECONDS * 1000 });
    deviceByUserCode.set(userCode, deviceCode);
    const base = options.publicUrl ?? `${req.protocol}://${req.get("host")}`;
    res.json({
      deviceCode,
      userCode,
      verificationUri: `${base}/activate`,
      // The code rides in the fragment: browsers don't send it to the server or write it to logs.
      verificationUriComplete: `${base}/activate#code=${userCode}`,
      expiresIn: DEVICE_SECONDS,
      interval: DEVICE_POLL_SECONDS,
    });
  });

  router.post("/device/approve", async (req, res) => {
    const parsed = UserCodeSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Enter the 8-character code shown on your TV." });
    const current = sessionOf(req);
    if (!current) return void res.status(401).json({ error: "Sign in on this phone first." });
    forgetExpiredDevices();
    const deviceCode = deviceByUserCode.get(normalizeUserCode(parsed.data.userCode));
    const grant = deviceCode ? devices.get(deviceCode) : undefined;
    if (!grant || grant.account || grant.cancelled) {
      return void res.status(400).json({ error: "That code has expired or isn't right. Get a new code on your TV." });
    }
    try {
      // Confirm the phone's sign-in is still live with Cognito before lending it to the TV.
      const tokens = await cognito().refresh(current.account.refreshToken);
      current.account.refreshToken = tokens.refreshToken ?? current.account.refreshToken;
      // The TV gets a copy of the account on the server, never the phone's cookie or tokens.
      grant.account = { ...current.account, expiresAt: Date.now() + REFRESH_DAYS * 86_400_000 };
      res.json({ ok: true, user: { email: current.account.email } });
    } catch (error) {
      if ((error as CognitoError).code === "NotAuthorizedException") {
        sessions.delete(current.sid);
        clearCookie(res, REFRESH_COOKIE, cookie);
        return void res.status(401).json({ error: "Your sign-in on this phone has ended. Sign in again." });
      }
      const { status, error: message } = failure(error);
      res.status(status).json({ error: message });
    }
  });

  /** The phone cancelled: the TV's code is void, so it can't be approved later. */
  router.post("/device/decline", (req, res) => {
    const parsed = UserCodeSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Enter the 8-character code shown on your TV." });
    const deviceCode = deviceByUserCode.get(normalizeUserCode(parsed.data.userCode));
    const grant = deviceCode ? devices.get(deviceCode) : undefined;
    if (grant && !grant.account) grant.cancelled = true;
    res.json({ ok: true });
  });

  /** The TV cancelled its own pairing. */
  router.post("/device/cancel", (req, res) => {
    const parsed = DeviceCodeSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Missing device code." });
    const grant = devices.get(parsed.data.deviceCode);
    if (grant && !grant.account) grant.cancelled = true;
    res.json({ ok: true });
  });

  router.post("/device/poll", async (req, res) => {
    const parsed = DeviceCodeSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Missing device code." });
    const grant = devices.get(parsed.data.deviceCode);
    if (!grant || grant.expiresAt <= Date.now()) return void res.json({ status: "expired" });
    if (grant.cancelled) {
      devices.delete(parsed.data.deviceCode);
      deviceByUserCode.delete(grant.userCode);
      return void res.json({ status: "cancelled" });
    }
    if (!grant.account || grant.redeeming) return void res.json({ status: "pending" });
    // Only one poll confirms the approval at a time. The grant stays until Cognito has answered, so a transient
    // error leaves the approval in place for the TV's next poll; a success spends the code.
    grant.redeeming = true;
    try {
      const tokens = await cognito().refresh(grant.account.refreshToken);
      grant.account.refreshToken = tokens.refreshToken ?? grant.account.refreshToken;
      devices.delete(parsed.data.deviceCode);
      deviceByUserCode.delete(grant.userCode);
      startSession(res, grant.account);
      res.json({ ok: true, status: "approved", ...sessionView(tokens, options.adminGroup) });
    } catch (error) {
      grant.redeeming = false;
      if ((error as CognitoError).code === "NotAuthorizedException") {
        // The phone's own sign-in has ended, so this approval can't be honored.
        devices.delete(parsed.data.deviceCode);
        deviceByUserCode.delete(grant.userCode);
        return void res.json({ status: "expired" });
      }
      const { status, error: message } = failure(error);
      res.status(status).json({ error: message });
    }
  });

  return router;
}
