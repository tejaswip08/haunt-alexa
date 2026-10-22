import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Story } from "./types.ts";

export interface StoryStore {
  get(id: string): Promise<Story | undefined>;
  put(story: Story): Promise<void>;
  list(): Promise<Story[]>;
  /** One owner's stories. Stores without an index can leave it out; callers then filter `list()`. */
  listByOwner?(ownerId: string): Promise<Story[]>;
}

/** One owner's stories, newest first, using the store's index when it has one. */
export async function storiesOwnedBy(store: StoryStore, ownerId: string): Promise<Story[]> {
  const stories = store.listByOwner ? await store.listByOwner(ownerId) : await store.list();
  return stories.filter((story) => story.ownerId === ownerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Keeps stories in process memory. Good for tests and short-lived demos. */
export class MemoryStore implements StoryStore {
  #stories = new Map<string, Story>();

  async get(id: string) {
    const story = this.#stories.get(id);
    return story && structuredClone(story);
  }

  async put(story: Story) {
    this.#stories.set(story.id, structuredClone(story));
  }

  async list() {
    return [...this.#stories.values()].map((story) => structuredClone(story));
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** One JSON file per story in a directory. Survives restarts; no database needed. */
export class FileStore implements StoryStore {
  constructor(readonly dir: string) {}

  #file(id: string) {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid story id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  async get(id: string) {
    if (!SAFE_ID.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(this.#file(id), "utf8")) as Story;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(story: Story) {
    await mkdir(this.dir, { recursive: true });
    const file = this.#file(story.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(story, null, 2));
    await rename(tmp, file);
  }

  async list() {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const stories = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => this.get(name.slice(0, -5))),
    );
    return stories.filter((story): story is Story => story !== undefined);
  }
}
