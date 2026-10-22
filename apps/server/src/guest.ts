import { createHash, randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { clearCookie, readCookie, setCookie } from "./cookies.ts";

/**
 * Guests (not signed in) on Haunt's own pages get a random key in an HttpOnly cookie. Their
 * stories record only its hash, which (1) keeps a guest's stories to that browser, and
 * (2) lets them move those stories into an account after signing up. A story id alone can
 * never claim a story. This is not an identity: guests can't list, submit or publish.
 */
const GUEST_COOKIE = "haunt_guest";
const GUEST_PATH = "/api";
/** A little longer than stories are kept (HAUNT_STORY_TTL_DAYS is 45 in production). */
const GUEST_DAYS = 60;
const KEY = /^[A-Za-z0-9_-]{43}$/;

export const hashGuestKey = (key: string) => createHash("sha256").update(`haunt-guest:${key}`).digest("hex");

/** The hash of this browser's guest key, if it has a valid one. */
export function guestKeyHash(req: Request): string | undefined {
  const key = readCookie(req, GUEST_COOKIE);
  return key && KEY.test(key) ? hashGuestKey(key) : undefined;
}

/** This browser's guest key hash, issuing a new key when it has none. */
export function ensureGuestKey(req: Request, res: Response, secure: boolean): string {
  const existing = guestKeyHash(req);
  if (existing) return existing;
  const key = randomBytes(32).toString("base64url");
  setCookie(res, GUEST_COOKIE, key, { path: GUEST_PATH, maxAgeSeconds: GUEST_DAYS * 86_400, secure });
  return hashGuestKey(key);
}

/** After claiming: new guest stories on this browser start a fresh key. */
export function forgetGuestKey(res: Response, secure: boolean) {
  clearCookie(res, GUEST_COOKIE, { path: GUEST_PATH, secure });
}
