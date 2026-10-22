import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { RateLimiter } from "./rate-limit.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** True when the request carries one of the bearer tokens. Constant-time comparison. */
export function hasBearerToken(req: Request, tokens: string[]): boolean {
  const supplied = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!supplied) return false;
  const given = digest(supplied);
  let ok = false;
  for (const token of tokens) ok = timingSafeEqual(given, digest(token)) || ok;
  return ok;
}

/**
 * True for requests from Haunt's own pages: same origin as the server (or an allowed
 * extra origin) and Haunt's client header, which cross-site pages can't add without CORS.
 */
export function isFirstParty(req: Request, header: { name: string; value: string }, extraOrigins: string[] = []): boolean {
  if (req.get(header.name) !== header.value) return false;
  const origin = req.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get("host") || extraOrigins.includes(origin);
  } catch {
    return false;
  }
}

/** Express middleware: one hit per request against `limiter`, keyed by client IP. */
export function rateLimit(limiter: RateLimiter, body: (retryAfter: number) => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = limiter.hit(req.ip ?? "unknown");
    if (result.ok) return next();
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json(body(result.retryAfterSeconds));
  };
}

/** Rejects bodies larger than `maxBytes`, by declared length and by the parsed body's size. */
export function maxBody(maxBytes: number, body: () => unknown) {
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = Number(req.get("content-length") ?? "0");
    if (declared > maxBytes) return void res.status(413).json(body());
    next();
  };
}
