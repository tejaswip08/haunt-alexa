import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { NextFunction, Request, Response } from "express";

/** A signed-in listener. `sub` is their stable, opaque Cognito id. */
export interface User {
  sub: string;
  admin: boolean;
}

export class AuthError extends Error {
  constructor(message = "Your sign-in has expired. Please sign in again.") {
    super(message);
    this.name = "AuthError";
  }
}

/** Who sent a request: a user, nobody (no credentials), or an AuthError for bad credentials. */
export type Authenticator = (req: Request) => Promise<User | undefined>;

export interface AuthenticatorOptions {
  /** e.g. https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbC123 */
  issuer: string;
  clientId: string;
  adminGroup: string;
  /** Signing keys. Defaults to the pool's published JWKS. */
  keys?: JWTVerifyGetKey;
}

/**
 * Verifies Cognito access tokens sent as `Authorization: Bearer …`: signature, issuer,
 * expiry, `token_use` and app client. ID tokens and tokens from other clients are refused.
 */
export function cognitoAuthenticator(options: AuthenticatorOptions): Authenticator {
  const keys = options.keys ?? createRemoteJWKSet(new URL(`${options.issuer}/.well-known/jwks.json`));
  return async (req) => {
    const token = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    // Not a JWT: no account is identified by it. Routes that need a signed-in account refuse it.
    if (!token || token.split(".").length !== 3) return undefined;
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: options.issuer, algorithms: ["RS256"] });
      if (payload.token_use !== "access" || payload.client_id !== options.clientId || typeof payload.sub !== "string") {
        throw new AuthError();
      }
      const groups = payload["cognito:groups"];
      return { sub: payload.sub, admin: Array.isArray(groups) && groups.includes(options.adminGroup) };
    } catch {
      throw new AuthError();
    }
  };
}

const DEV_USER = /^dev-[a-z0-9]{8,32}$/;

/**
 * Local development without a user pool: the browser picks a random `dev-…` id and sends it
 * as X-Haunt-Dev-User. Never enabled in production. Dev users are never admins.
 */
export const devAuthenticator: Authenticator = async (req) => {
  const id = req.get("x-haunt-dev-user");
  if (!id) return undefined;
  if (!DEV_USER.test(id)) throw new AuthError("That development user id isn't valid.");
  return { sub: id, admin: false };
};

export function authenticatorFor(config: {
  production: boolean;
  awsRegion: string;
  cognitoUserPoolId?: string;
  cognitoClientId?: string;
  adminGroup: string;
}): Authenticator {
  if (config.cognitoUserPoolId && config.cognitoClientId) {
    return cognitoAuthenticator({
      issuer: `https://cognito-idp.${config.awsRegion}.amazonaws.com/${config.cognitoUserPoolId}`,
      clientId: config.cognitoClientId,
      adminGroup: config.adminGroup,
    });
  }
  return config.production ? async () => undefined : devAuthenticator;
}

/** Puts the caller in `res.locals.user`, or answers 401 for credentials that don't verify. */
export function identify(authenticate: Authenticator) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.user = await authenticate(req);
      next();
    } catch (error) {
      if (!(error instanceof AuthError)) return next(error);
      res.setHeader("WWW-Authenticate", 'Bearer realm="haunt"');
      res.status(401).json({ error: error.message });
    }
  };
}

export const userOf = (res: Response): User | undefined => res.locals.user as User | undefined;
