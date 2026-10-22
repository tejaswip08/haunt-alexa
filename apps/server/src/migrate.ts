import type { StoryStore } from "@firetales/core";
import type { Library, LibraryEntry } from "./library.ts";

/** Insert-only targets: each returns false when the record already exists, and never overwrites it. */
export interface MigrationTarget {
  putStoryIfAbsent(story: Awaited<ReturnType<StoryStore["get"]>> & {}): Promise<boolean>;
  putEntryIfAbsent(entry: LibraryEntry): Promise<boolean>;
}

export interface MigrationReport {
  stories: { found: number; copied: number; alreadyThere: number };
  library: { found: number; copied: number; alreadyThere: number };
  dryRun: boolean;
}

/**
 * Copies local stories and library episodes into another store. Repeatable: records that
 * already exist in the target are left alone, and the source is never modified or deleted.
 */
export async function migrate(
  source: { stories: StoryStore; library: Library },
  target: MigrationTarget,
  options: { dryRun: boolean; onRecord?: (kind: "story" | "episode", id: string, result: "copied" | "already there" | "would copy") => void },
): Promise<MigrationReport> {
  const report: MigrationReport = {
    stories: { found: 0, copied: 0, alreadyThere: 0 },
    library: { found: 0, copied: 0, alreadyThere: 0 },
    dryRun: options.dryRun,
  };
  for (const story of await source.stories.list()) {
    report.stories.found++;
    if (options.dryRun) {
      options.onRecord?.("story", story.id, "would copy");
      continue;
    }
    const copied = await target.putStoryIfAbsent(story);
    report.stories[copied ? "copied" : "alreadyThere"]++;
    options.onRecord?.("story", story.id, copied ? "copied" : "already there");
  }
  for (const entry of await source.library.list()) {
    report.library.found++;
    if (options.dryRun) {
      options.onRecord?.("episode", entry.episode.storyId, "would copy");
      continue;
    }
    const copied = await target.putEntryIfAbsent(entry);
    report.library[copied ? "copied" : "alreadyThere"]++;
    options.onRecord?.("episode", entry.episode.storyId, copied ? "copied" : "already there");
  }
  return report;
}
