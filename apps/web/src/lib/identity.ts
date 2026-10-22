import { randomId } from "./id.ts";

/**
 * Who the listener is, as request headers for Haunt's own API and MCP route.
 *
 * - Signed in: the Cognito access token (held in memory by session.ts), as a Bearer token.
 * - Local development without a user pool: a random `dev-…` id kept in this browser, so My
 *   Stories works on a laptop. The server ignores it in production and whenever a pool is set up.
 * - Otherwise nothing: a guest, known to the server only by an HttpOnly guest-key cookie.
 */
const DEV_USER_KEY = "haunt-dev-user";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function identityHeaders(options: {
  token?: string | null;
  dev: boolean;
  local?: KeyValueStore;
  newId?: () => string;
}): Record<string, string> {
  if (options.token) return { Authorization: `Bearer ${options.token}` };
  if (!options.dev) return {};
  let id = read(options.local, DEV_USER_KEY);
  if (!id || !/^dev-[a-z0-9]{8,32}$/.test(id)) {
    id = `dev-${(options.newId ?? randomId)().replaceAll("-", "").toLowerCase().slice(0, 24)}`;
    try {
      options.local?.setItem(DEV_USER_KEY, id);
    } catch {
      // Private mode: a new id each visit, so stories from earlier visits won't be listed.
    }
  }
  return { "X-Haunt-Dev-User": id };
}

function read(store: KeyValueStore | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
