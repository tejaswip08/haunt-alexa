/**
 * The admin Publish action: call the server, and only once it confirms, open /library with
 * the new story highlighted. On any failure the caller stays on the admin page with the error.
 */
export interface PublishRequest {
  storyId: string;
  creator: string;
  summary: string;
  allowDuplicate?: boolean;
}

export interface PublishResponse {
  ok?: boolean;
  action?: "created" | "updated";
  warnings?: { storyId: string; title: string; reason: string }[];
}

export type PublishOutcome =
  | { ok: true; action: "created" | "updated"; url: string }
  | { ok: false; error: string; duplicateOf?: string };

/** The /library address that confirms a publish: which story, and whether it was new. */
export function libraryUrlAfterPublish(storyId: string, action: "created" | "updated"): string {
  return `/library?published=${encodeURIComponent(storyId)}&action=${action}`;
}

export async function publishAndOpenLibrary(
  request: (path: string, body: PublishRequest) => Promise<PublishResponse>,
  navigate: (url: string) => void,
  body: PublishRequest,
  /** "/approve" for a listener's submitted story, which publishes it the same way. */
  path: "/publish" | "/approve" = "/publish",
): Promise<PublishOutcome> {
  let response: PublishResponse;
  try {
    response = await request(path, body);
  } catch (error) {
    const data = (error as { data?: { duplicateOf?: unknown } }).data;
    return {
      ok: false,
      error: (error as Error).message || "Publishing failed.",
      ...(typeof data?.duplicateOf === "string" ? { duplicateOf: data.duplicateOf } : {}),
    };
  }
  // A 200 without a confirmed action isn't a success worth navigating for.
  if (!response?.ok || (response.action !== "created" && response.action !== "updated")) {
    return { ok: false, error: "The server didn't confirm the publish. Nothing changed in the library view." };
  }
  const url = libraryUrlAfterPublish(body.storyId, response.action);
  navigate(url);
  return { ok: true, action: response.action, url };
}

/** What /library should announce, read from its own address. */
export function publishNotice(search: string): { storyId: string; message: string } | null {
  const params = new URLSearchParams(search);
  const storyId = params.get("published");
  if (!storyId) return null;
  const updated = params.get("action") === "updated";
  return { storyId, message: updated ? "Story updated successfully." : "Story published successfully." };
}
