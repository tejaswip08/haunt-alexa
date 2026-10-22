// Trending and Featured Tonight, as the Home page reads them. Both endpoints answer 503 while their switch is off (or the
// database read fails), and a server without the route answers 404. Either means "not available here" and the rail is left out. Any other failure is an error the
// rail says so about. Nothing here invents a story: a ranked or featured id with no known story is dropped.

export interface TrendingEntry {
  storyId: string;
  plays: number;
}

export interface FeaturedEntry {
  storyId: string;
  startsAt: string;
  endsAt: string;
}

export type Discovery<T> = { kind: "loading" } | { kind: "ok"; items: T[] } | { kind: "unavailable" } | { kind: "error" };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function readList<T>(fetcher: Fetcher, path: string, pick: (data: Record<string, unknown>) => T[]): Promise<Discovery<T>> {
  try {
    const response = await fetcher(path, { credentials: "same-origin" });
    // 503 is the switch being off (or a failed read); 404 is a server that does not have the route yet. Both mean "not here".
    if (response.status === 503 || response.status === 404) return { kind: "unavailable" };
    if (!response.ok) return { kind: "error" };
    return { kind: "ok", items: pick((await response.json()) as Record<string, unknown>) };
  } catch {
    return { kind: "error" };
  }
}

/** GET /api/trending: ranked story ids, most trending first. */
export function fetchTrending(fetcher: Fetcher = fetch): Promise<Discovery<TrendingEntry>> {
  return readList(fetcher, "/api/trending", (data) => {
    const stories = Array.isArray(data.stories) ? (data.stories as TrendingEntry[]) : [];
    return stories.filter((s) => typeof s?.storyId === "string").map((s) => ({ storyId: s.storyId, plays: Number(s.plays) || 0 }));
  });
}

/** GET /api/featured: the features on air now, in the server's order. Empty when nothing is featured. */
export function fetchFeatured(fetcher: Fetcher = fetch): Promise<Discovery<FeaturedEntry>> {
  return readList(fetcher, "/api/featured", (data) => {
    const features = Array.isArray(data.features) ? (data.features as FeaturedEntry[]) : [];
    return features.filter((f) => typeof f?.storyId === "string");
  });
}

/** The known stories for these ids, in the same order. Ids with no known story are left out. */
export function knownStories<T>(ids: string[], known: ReadonlyMap<string, T>): T[] {
  return ids.flatMap((id) => {
    const story = known.get(id);
    return story ? [story] : [];
  });
}
