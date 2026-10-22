import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { AuthError, devAuthenticator, type Authenticator } from "./auth.ts";
import { SIGN_IN_CODE_DIGITS } from "./auth-route.ts";
import { CognitoError, type CognitoClient, type CognitoTokens } from "./cognito-client.ts";

/**
 * Offline stand-in for Cognito's passwordless email sign-in (HAUNT_AUTH=mock), so sign-in can
 * be tried locally with no user pool. Codes are printed to the server console instead of
 * emailed. Tokens are real JWTs signed with a random key made at start-up, so every session
 * ends when the server restarts. Never enabled in production (config.ts refuses it).
 */
const ISSUER = "haunt-mock-auth";
const ACCESS_SECONDS = 3600;
const CONFIRMED_SESSION = "mock-confirmed";

export function createMockAuth(log: (line: string) => void = console.log) {
  const secret = randomBytes(32);
  const users = new Map<string, { sub: string; confirmed: boolean }>();
  /** The last code "emailed" to each address, and what it is for. */
  const codes = new Map<string, { code: string; kind: "confirm" | "signin" }>();
  const refreshTokens = new Map<string, string>();

  function sendCode(email: string, kind: "confirm" | "signin") {
    // Sign-in codes match the length the sign-in screens ask for; confirmation codes stay six digits, like Cognito's.
    const digits = kind === "signin" ? SIGN_IN_CODE_DIGITS : 6;
    const code = String(randomInt(10 ** (digits - 1), 10 ** digits));
    codes.set(email, { code, kind });
    log(`[auth:mock] ${kind === "confirm" ? "Confirmation" : "Sign-in"} code for ${email}: ${code}`);
  }

  function useCode(email: string, code: string, kind: "confirm" | "signin") {
    const sent = codes.get(email);
    if (!sent || sent.kind !== kind || sent.code !== code) throw new CognitoError("CodeMismatchException", "Wrong code");
    codes.delete(email);
  }

  async function tokens(email: string, withRefresh = true): Promise<CognitoTokens> {
    const { sub } = users.get(email)!;
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${ACCESS_SECONDS}s`)
        .sign(secret);
    const refreshToken = withRefresh ? randomBytes(32).toString("base64url") : undefined;
    if (refreshToken) refreshTokens.set(refreshToken, email);
    return {
      accessToken: await sign({ token_use: "access", "cognito:groups": [] }),
      idToken: await sign({ token_use: "id", email }),
      refreshToken,
      expiresIn: ACCESS_SECONDS,
    };
  }

  const cognito: CognitoClient = {
    async signUp(email) {
      if (users.has(email)) throw new CognitoError("UsernameExistsException", "Account exists");
      users.set(email, { sub: randomUUID(), confirmed: false });
      sendCode(email, "confirm");
    },
    async resendConfirmation(email) {
      sendCode(email, "confirm");
    },
    async confirmSignUp(email, code) {
      useCode(email, code, "confirm");
      users.get(email)!.confirmed = true;
      return CONFIRMED_SESSION;
    },
    async startSignIn(email, session) {
      // Mock accounts live in memory and vanish on every restart, so an unknown address gets an account on the
      // spot instead of the silent "no account" a real pool gives. Otherwise "Email me a code" never prints one.
      if (!users.has(email)) users.set(email, { sub: randomUUID(), confirmed: true });
      const user = users.get(email)!;
      if (!user.confirmed) throw new CognitoError("UserNotConfirmedException", "Not confirmed");
      if (session === CONFIRMED_SESSION) return { kind: "tokens", tokens: await tokens(email) };
      sendCode(email, "signin");
      return { kind: "code", session: "mock-signin" };
    },
    async answerCode(email, _session, code) {
      useCode(email, code, "signin");
      return { kind: "tokens", tokens: await tokens(email) };
    },
    async refresh(refreshToken) {
      const email = refreshTokens.get(refreshToken);
      if (!email) throw new CognitoError("NotAuthorizedException", "Unknown refresh token");
      return tokens(email, false);
    },
    async revoke(refreshToken) {
      refreshTokens.delete(refreshToken);
    },
  };

  /** Verifies this server's mock access tokens; without one, falls back to the dev stand-in. */
  const authenticate: Authenticator = async (req) => {
    const token = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!token || token.split(".").length !== 3) return devAuthenticator(req);
    try {
      const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: ["HS256"] });
      if (payload.token_use !== "access" || typeof payload.sub !== "string") throw new AuthError();
      return { sub: payload.sub, admin: false };
    } catch {
      throw new AuthError();
    }
  };

  /**
   * Development only: a fixed local test identity, so testing doesn't need codes. Mounted only when index.ts confirms
   * isolated mock mode with a local DynamoDB endpoint. The same sub every start, so per-user data stays with it.
   */
  const TEST_EMAIL = "test-user@haunt.local.test";
  const TEST_SUB = "local-test-user";
  async function devLogin(): Promise<CognitoTokens> {
    if (!users.has(TEST_EMAIL)) users.set(TEST_EMAIL, { sub: TEST_SUB, confirmed: true });
    return tokens(TEST_EMAIL);
  }

  /** Development only: a session for a fixed local identity (dev-identities.ts). Its sub never changes. */
  async function devLoginAs(email: string, sub: string): Promise<CognitoTokens> {
    const known = users.get(email);
    if (known && known.sub !== sub) throw new Error("A development identity changed its subject.");
    if (!known) users.set(email, { sub, confirmed: true });
    return tokens(email);
  }

  return { cognito, authenticate, devLogin, devLoginAs };
}
