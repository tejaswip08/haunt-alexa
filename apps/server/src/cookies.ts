import type { Request, Response } from "express";

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(rest.join("="));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export interface CookieOptions {
  path: string;
  maxAgeSeconds: number;
  /** Secure cookies only travel over HTTPS; off for http://localhost development. */
  secure: boolean;
}

/** Always HttpOnly and SameSite=Strict: page scripts can't read these, and other sites can't send them. */
export function setCookie(res: Response, name: string, value: string, options: CookieOptions) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(options.secure ? ["Secure"] : []),
  ];
  res.append("Set-Cookie", parts.join("; "));
}

export function clearCookie(res: Response, name: string, options: Omit<CookieOptions, "maxAgeSeconds">) {
  setCookie(res, name, "", { ...options, maxAgeSeconds: 0 });
}
