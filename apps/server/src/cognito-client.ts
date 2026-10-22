/**
 * The few Cognito user pool APIs Haunt's passwordless sign-in needs, over plain HTTPS.
 * These calls are made on behalf of a user, with a public app client (no secret), so they
 * need no AWS credentials or request signing.
 */

export interface CognitoTokens {
  accessToken: string;
  idToken?: string;
  /** Only on first sign-in, or when Cognito rotates it. */
  refreshToken?: string;
  expiresIn: number;
}

/** A Cognito error, by its exception name (e.g. CodeMismatchException). */
export class CognitoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

export interface CognitoClientOptions {
  region: string;
  clientId: string;
  /** For tests: a fake Cognito endpoint. */
  endpoint?: string;
  fetch?: typeof fetch;
}

export type Step =
  /** A code was emailed; send it back with this session. */
  | { kind: "code"; session: string }
  | { kind: "tokens"; tokens: CognitoTokens };

export interface CognitoClient {
  /** Create a passwordless account; Cognito emails a confirmation code. */
  signUp(email: string): Promise<void>;
  /** Send the confirmation code again, for an account that was never confirmed. */
  resendConfirmation(email: string): Promise<void>;
  /** Confirm the account with the code; returns a session that signs in without a second code. */
  confirmSignUp(email: string, code: string): Promise<string | undefined>;
  /** Start sign-in with an emailed one-time code, or finish it with a session from confirmSignUp. */
  startSignIn(email: string, session?: string): Promise<Step>;
  answerCode(email: string, session: string, code: string): Promise<Step>;
  refresh(refreshToken: string): Promise<CognitoTokens>;
  revoke(refreshToken: string): Promise<void>;
}

interface AuthResult {
  AuthenticationResult?: { AccessToken?: string; IdToken?: string; RefreshToken?: string; ExpiresIn?: number };
  ChallengeName?: string;
  Session?: string;
}

export function createCognitoClient(options: CognitoClientOptions): CognitoClient {
  const endpoint = options.endpoint ?? `https://cognito-idp.${options.region}.amazonaws.com/`;
  const send = options.fetch ?? fetch;
  const ClientId = options.clientId;

  async function call<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    const response = await send(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${operation}`,
      },
      body: JSON.stringify({ ClientId, ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      // "__type" is e.g. "CodeMismatchException" or "com.amazonaws…#CodeMismatchException".
      const code = String(data.__type ?? data.code ?? "UnknownError").split("#").pop()!;
      throw new CognitoError(code, String(data.message ?? data.Message ?? operation));
    }
    return data as T;
  }

  function step(result: AuthResult): Step {
    const auth = result.AuthenticationResult;
    if (auth?.AccessToken) {
      return {
        kind: "tokens",
        tokens: { accessToken: auth.AccessToken, idToken: auth.IdToken, refreshToken: auth.RefreshToken, expiresIn: auth.ExpiresIn ?? 3600 },
      };
    }
    // Cognito's built-in passwordless email code. Cognito generates it and decides its length.
    if (result.ChallengeName === "EMAIL_OTP" && result.Session) return { kind: "code", session: result.Session };
    // Any other challenge (password, SMS, passkey) means the pool isn't set up for email codes.
    throw new CognitoError("UnsupportedChallenge", `Unexpected sign-in step ${result.ChallengeName ?? "none"}`);
  }

  return {
    async signUp(email) {
      await call("SignUp", { Username: email, UserAttributes: [{ Name: "email", Value: email }] });
    },
    async resendConfirmation(email) {
      await call("ResendConfirmationCode", { Username: email });
    },
    async confirmSignUp(email, code) {
      const result = await call<{ Session?: string }>("ConfirmSignUp", { Username: email, ConfirmationCode: code });
      return result.Session;
    },
    async startSignIn(email, session) {
      return step(
        await call<AuthResult>("InitiateAuth", {
          AuthFlow: "USER_AUTH",
          AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "EMAIL_OTP" },
          ...(session ? { Session: session } : {}),
        }),
      );
    },
    async answerCode(email, session, code) {
      return step(
        await call<AuthResult>("RespondToAuthChallenge", {
          ChallengeName: "EMAIL_OTP",
          Session: session,
          ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code },
        }),
      );
    },
    async refresh(refreshToken) {
      const result = step(
        await call<AuthResult>("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: refreshToken } }),
      );
      if (result.kind !== "tokens") throw new CognitoError("NotAuthorizedException", "Refresh needs a new sign-in");
      return result.tokens;
    },
    async revoke(refreshToken) {
      await call("RevokeToken", { Token: refreshToken });
    },
  };
}
