/**
 * The published-story list shared by /library and /tv. Both read list_library (one entry
 * per source story id, newest first, from the server) and pass it through here, so the two
 * screens always show the same stories in the same order, with no limit.
 */
export interface LibraryCard {
  storyId: string;
  title: string;
  summary: string;
  creator: string;
  minutes: number;
  language?: string;
  parts?: number;
  publishedAt?: string;
  /** Live totals (engagement.ts); null when the database isn't available. */
  likes?: number | null;
  plays?: number | null;
}

/** One card per story id, keeping the server's order. Never trims the list. */
export function toLibraryCards(episodes: readonly LibraryCard[] | undefined | null): LibraryCard[] {
  const seen = new Set<string>();
  const cards: LibraryCard[] = [];
  for (const episode of episodes ?? []) {
    if (!episode?.storyId || seen.has(episode.storyId)) continue;
    seen.add(episode.storyId);
    cards.push(episode);
  }
  return cards;
}

/** Fetches the library through the given MCP client. Always a fresh call: nothing is cached. */
export async function fetchLibrary(client: { callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown> }) {
  const result = (await client.callTool({ name: "list_library", arguments: {} })) as {
    structuredContent?: { episodes?: LibraryCard[] };
    isError?: boolean;
  };
  if (result.isError) throw new Error("The library couldn't be loaded.");
  return toLibraryCards(result.structuredContent?.episodes);
}
