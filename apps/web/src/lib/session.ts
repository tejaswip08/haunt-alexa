import { useSyncExternalStore } from "react";
import { identityHeaders, type KeyValueStore } from "./identity.ts";

/**
 * The listener's sign-in session (Cognito email codes, through /api/auth).
 *
 * The access token lives only in memory; the refresh token is an HttpOnly cookie this code
 * can't read. On load, `init()` asks the server for a fresh access token, which restores the
 * session after a reload. Tokens are renewed a minute before they expire, and a request that
 * gets 401 is retried once after renewing. If renewal fails, the listener becomes a guest
 * again and sees "Your session ended".
 */

export interface SessionUser {
  email: string | null;
  /** Only decides which links to show. The server checks admin rights itself. */
  admin: boolean;
}

export interface SessionState {
  status: "loading" | "guest" | "signed-in";
  user: SessionUser | null;
  /** False when this server has no user pool: everyone plays as a guest. */
  available: boolean;
  /** Set when a signed-in session ended by itself (expired or revoked). */
  expired: boolean;
  /** Local test sign-in (HAUNT_AUTH=mock): no email is sent; codes print in the server's terminal. */
  testMode?: boolean;
}

/**
 * `codeLength` is the number of digits the sign-in code has (eight for Cognito's email code), or null when
 * the code comes from Cognito's account confirmation and Cognito decides its length.
 */
export type CodeResult =
  | { ok: true; signedIn: boolean; codeLength?: number | null }
  | { ok: false; error: string; restart?: boolean };

interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const AUTH_HEADERS = { "X-Haunt-Client": "web", "Content-Type": "application/json" };
const RENEW_EARLY_MS = 60_000;

export class Session {
  #state: SessionState = { status: "loading", user: null, available: false, expired: false };
  #token: string | null = null;
  #expiresAt = 0;
  #renewing: Promise<boolean> | undefined;
  #listeners = new Set<() => void>();
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #dev: boolean;
  readonly #local: KeyValueStore | undefined;

  constructor(options: { fetch: Fetch; now?: () => number; dev: boolean; local?: KeyValueStore }) {
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#dev = options.dev;
    this.#local = options.local;
  }

  get state() {
    return this.#state;
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Whether sign-in exists here, and restore a session from the refresh cookie. */
  async init(): Promise<void> {
    let available = false;
    try {
      const health = (await (await this.#fetch("/api/health")).json()) as { signIn?: string; authMock?: boolean };
      available = health.signIn === "email-otp";
      if (health.authMock === true) this.#set({ testMode: true });
    } catch {
      // Offline: stay a guest.
    }
    this.#set({ available });
    if (!available) return this.#set({ status: "guest" });
    await this.#renew(false);
  }

  /** Emails a code to sign in, or to confirm a new account. */
  async start(email: string, mode: "signin" | "signup"): Promise<CodeResult> {
    return this.#codeCall("/api/auth/start", { email, mode });
  }

  async verify(code: string): Promise<CodeResult> {
    return this.#codeCall("/api/auth/verify", { code });
  }

  async signOut(): Promise<void> {
    await this.#fetch("/api/auth/signout", { method: "POST", headers: AUTH_HEADERS }).catch(() => undefined);
    this.#token = null;
    this.#set({ status: "guest", user: null, expired: false });
  }

  dismissExpired() {
    this.#set({ expired: false });
  }

  /** Identity headers for one request, renewing the token first if it's about to expire. */
  async headers(): Promise<Record<string, string>> {
    if (this.#token && this.#now() > this.#expiresAt - RENEW_EARLY_MS) await this.#renew(true);
    return identityHeaders({ token: this.#token, dev: this.#dev, local: this.#local });
  }

  /** fetch() with the listener's identity; a 401 renews the session once and retries. */
  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const send = async () => {
      const headers = new Headers(init.headers);
      for (const [name, value] of Object.entries(await this.headers())) headers.set(name, value);
      return this.#fetch(input, { ...init, headers });
    };
    const response = await send();
    if (response.status !== 401 || !this.#token) return response;
    return (await this.#renew(true)) ? send() : response;
  };

  async #codeCall(path: string, body: unknown): Promise<CodeResult> {
    let response: Response;
    try {
      response = await this.#fetch(path, { method: "POST", headers: AUTH_HEADERS, body: JSON.stringify(body) });
    } catch {
      return { ok: false, error: "Couldn't reach Haunt. Check your connection and try again." };
    }
    const data = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & {
      error?: string;
      restart?: boolean;
      codeLength?: number | null;
    };
    if (!response.ok) return { ok: false, error: data.error ?? "Something went wrong. Try again.", restart: data.restart };
    if (data.accessToken) {
      this.#signedIn(data as TokenResponse);
      return { ok: true, signedIn: true };
    }
    // Only include codeLength when the server sent one: SignIn treats a missing value as the default length.
    return data.codeLength === undefined ? { ok: true, signedIn: false } : { ok: true, signedIn: false, codeLength: data.codeLength };
  }

  /** One renewal at a time. `wasSignedIn` decides whether failing means "your session ended". */
  #renew(wasSignedIn: boolean): Promise<boolean> {
    this.#renewing ??= (async () => {
      try {
        const response = await this.#fetch("/api/auth/refresh", { method: "POST", headers: AUTH_HEADERS });
        if (response.ok) {
          this.#signedIn((await response.json()) as TokenResponse);
          return true;
        }
        if (response.status === 401) {
          this.#token = null;
          this.#set({ status: "guest", user: null, expired: wasSignedIn || this.#state.status === "signed-in" });
          return false;
        }
        // Server or Cognito trouble: keep the current state and let the caller see the error.
        if (this.#state.status === "loading") this.#set({ status: "guest" });
        return false;
      } catch {
        if (this.#state.status === "loading") this.#set({ status: "guest" });
        return false;
      } finally {
        this.#renewing = undefined;
      }
    })();
    return this.#renewing;
  }

  #signedIn(data: TokenResponse) {
    this.#token = data.accessToken;
    this.#expiresAt = this.#now() + data.expiresIn * 1000;
    this.#set({ status: "signed-in", user: data.user, expired: false });
  }

  #set(patch: Partial<SessionState>) {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((listener) => listener());
  }
}

function safeLocal(): KeyValueStore | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export const session = new Session({
  fetch: (input, init) => fetch(input, init),
  // Undefined outside Vite (unit tests).
  dev: Boolean(import.meta.env?.DEV),
  local: typeof window === "undefined" ? undefined : safeLocal(),
});

export function useSession(): SessionState {
  return useSyncExternalStore(session.subscribe, () => session.state);
}
