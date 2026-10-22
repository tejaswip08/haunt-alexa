/**
 * The two local test identities for role testing, used only by the development sign-in (auth-route.ts, /dev-login). Fixed
 * subs, so the same profile records are reused on every local run. They exist only in isolated mock mode with DynamoDB Local
 * (index.ts), and never in production. A role here is provisioned once and never overwritten (profiles.ts, provisionRole).
 */
import type { Role } from "./roles.ts";

export const DEV_IDENTITIES = {
  listener: { sub: "local-test-listener", email: "listener@haunt.local.test", role: "LISTENER" },
  admin: { sub: "local-test-admin", email: "admin@haunt.local.test", role: "ADMIN" },
} as const satisfies Record<string, { sub: string; email: string; role: Role }>;

export type DevIdentity = keyof typeof DEV_IDENTITIES;

export function isDevIdentity(value: unknown): value is DevIdentity {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEV_IDENTITIES, value);
}
