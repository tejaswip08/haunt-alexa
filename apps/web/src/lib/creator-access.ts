import { session } from "./session.ts";

/**
 * The web client's calls to Haunt's Creator access and role endpoints. They go through the signed-in session
 * (`session.fetch` adds the verified identity and renews an expired token once). Roles and requests come only from
 * these server responses; nothing is cached in local storage.
 */

export type AccountRole = "LISTENER" | "CREATOR" | "ADMIN";

export interface CreatorRequestView {
  subject?: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedAt: string;
  updatedAt: string;
  decidedAt?: string;
  reason?: string;
}

export interface PendingCreatorRequest extends CreatorRequestView {
  subject: string;
  displayName: string | null;
  email: string | null;
}

/** An error the UI can show as given. `status` lets callers tell 401 (sign in again) from 403 (not allowed). */
export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = await session.fetch(path, { method });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (response.status === 401) throw new AccessError("Your sign-in has ended. Sign in again.", 401);
  if (response.status === 403) throw new AccessError(data.error ?? "Your account can't do that.", 403);
  if (!response.ok) throw new AccessError(data.error ?? "Something went wrong. Try again.", response.status);
  return data;
}

/** The signed-in listener's role, as the server stores it. A missing role is a LISTENER. */
export async function myRole(): Promise<AccountRole> {
  const data = await call<{ profile: { role?: AccountRole } }>("/api/users/me");
  return data.profile.role ?? "LISTENER";
}

/** This listener's Creator access request, or null when there is none. */
export async function myCreatorRequest(): Promise<CreatorRequestView | null> {
  return (await call<{ request: CreatorRequestView | null }>("/api/creator-access/me")).request;
}

/** Asks for Creator access. It grants nothing until an admin approves. */
export async function requestCreatorAccess(): Promise<CreatorRequestView> {
  return (await call<{ request: CreatorRequestView }>("/api/creator-access/me", "POST")).request;
}

/** Admins only: the pending requests. */
export async function pendingCreatorRequests(): Promise<PendingCreatorRequest[]> {
  return (await call<{ requests: PendingCreatorRequest[] }>("/api/creator-access/admin/requests")).requests;
}

/** Admins only: approves or rejects one request. The server re-checks the role and the pending state. */
export async function decideCreatorRequest(subject: string, outcome: "approve" | "reject"): Promise<void> {
  await call<{ ok: boolean }>(`/api/creator-access/admin/requests/${encodeURIComponent(subject)}/${outcome}`, "POST");
}
