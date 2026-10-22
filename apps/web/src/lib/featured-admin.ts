// Featured Tonight, for the admin schedule page: the rules the form checks before it sends, the request helpers, and the
// status of each entry. The server checks the same rules again (featured.ts), so this only saves a round trip and explains
// a mistake in words. Times are UTC: the form reads and writes them as UTC, never the viewer's local zone.

export interface FeaturedEntry {
  storyId: string;
  /** ISO 8601, UTC. */
  startsAt: string;
  /** ISO 8601, UTC. Exclusive. */
  endsAt: string;
}

export interface Schedule {
  entries: FeaturedEntry[];
  version: number;
}

export type EntryStatus = "live" | "upcoming" | "ended";

// The same limits as apps/server/src/featured.ts.
export const MAX_FEATURE_MS = 14 * 86_400_000;
export const MAX_LEAD_MS = 60 * 86_400_000;

/** A `datetime-local` value ("2026-10-22T18:00") read as UTC, as an ISO string. Undefined when it isn't a real time. */
export function utcIsoFromLocalInput(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const time = Date.parse(`${value}:00Z`);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** The form's value for an ISO time, in UTC, so editing an entry shows the same instant it was saved with. */
export function utcInputFromIso(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16);
}

export interface SelectionInput {
  storyId: string;
  startsAt: string;
  endsAt: string;
}

/** Plain-language problems with a selection, empty when it can be sent. `publishedIds` are the stories that may be featured. */
export function selectionProblems(input: Partial<SelectionInput>, now: number, publishedIds: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (!input.storyId) problems.push("Choose a published story.");
  else if (!publishedIds.has(input.storyId)) problems.push("Only a published story can be featured.");
  const start = input.startsAt ? Date.parse(input.startsAt) : NaN;
  const end = input.endsAt ? Date.parse(input.endsAt) : NaN;
  if (!Number.isFinite(start)) problems.push("Enter a start time (UTC).");
  if (!Number.isFinite(end)) problems.push("Enter an end time (UTC).");
  if (Number.isFinite(start) && Number.isFinite(end)) {
    if (end <= start) problems.push("The end must be after the start.");
    else if (end - start > MAX_FEATURE_MS) problems.push("A feature can run for at most 14 days.");
    if (start - now > MAX_LEAD_MS) problems.push("A feature can start at most 60 days from now.");
    if (end <= now) problems.push("That window has already ended. Choose a later time.");
  }
  return problems;
}

/** Live now, coming up, or over. Matches the server's window: the start is included, the end is not. */
export function entryStatus(entry: FeaturedEntry, now: number): EntryStatus {
  if (Date.parse(entry.endsAt) <= now) return "ended";
  if (Date.parse(entry.startsAt) > now) return "upcoming";
  return "live";
}

export const STATUS_LABEL: Record<EntryStatus, string> = { live: "On air now", upcoming: "Scheduled", ended: "Ended" };

export type AdminResult<T> = { ok: true; value: T } | { ok: false; message: string; status: number };

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

/** Turns a failed response into a message the admin can act on. 409 means someone else changed the schedule. */
export function apiMessage(status: number, data: { error?: unknown }): string {
  if (status === 401) return "Sign in as an admin to change Featured Tonight.";
  if (status === 403) return "Your account can't change Featured Tonight. Ask an admin.";
  if (status === 409) return "Someone else changed the schedule. It has been reloaded; check it and try again.";
  if (status === 422) return typeof data.error === "string" ? data.error : "That story can't be featured.";
  if (status === 400) return typeof data.error === "string" ? data.error : "Check the times and try again.";
  if (status === 503) return "Featured Tonight isn't turned on for this server, or it couldn't save right now.";
  return "Something went wrong. Try again.";
}

async function call<T>(fetcher: Fetcher, path: string, init?: RequestInit): Promise<AdminResult<T>> {
  try {
    const response = await fetcher(path, init);
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: unknown };
    if (!response.ok) return { ok: false, status: response.status, message: apiMessage(response.status, data) };
    return { ok: true, value: data as T };
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach the server. Check your connection and try again." };
  }
}

/** GET /api/admin/featured: the current schedule and its version. */
export function loadSchedule(fetcher: Fetcher): Promise<AdminResult<Schedule>> {
  return call<Schedule>(fetcher, "/api/admin/featured");
}

/** PUT /api/admin/featured: adds or replaces a selection. The version guards against overwriting another admin's change. */
export function saveSelection(fetcher: Fetcher, input: SelectionInput, expectedVersion: number): Promise<AdminResult<Schedule>> {
  return call<Schedule>(fetcher, "/api/admin/featured", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, expectedVersion }),
  });
}

/** DELETE /api/admin/featured/:storyId: removes a selection. */
export function removeSelection(fetcher: Fetcher, storyId: string, expectedVersion: number): Promise<AdminResult<Schedule>> {
  return call<Schedule>(fetcher, `/api/admin/featured/${encodeURIComponent(storyId)}?expectedVersion=${expectedVersion}`, { method: "DELETE" });
}
