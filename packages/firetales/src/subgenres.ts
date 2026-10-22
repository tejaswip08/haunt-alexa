// The canonical horror sub-genre ids. The Create screen (apps/tv/src/data/catalog.ts) must list the same ids;
// apps/tv/test/createStory.test.ts fails if the two drift. Names, descriptions and art stay with the client.
import type { SceneArtId } from "./images.ts";

export const SUBGENRE_IDS = [
  "paranormal",
  "ghost",
  "haunted-house",
  "possession",
  "psychological",
  "folk",
  "cosmic",
  "slasher",
  "gothic",
  "creature",
  "cult",
  "survival",
] as const;
export type SubgenreId = (typeof SUBGENRE_IDS)[number];

export function isSubgenreId(value: unknown): value is SubgenreId {
  return typeof value === "string" && (SUBGENRE_IDS as readonly string[]).includes(value);
}

/**
 * Scene artwork used when the scene's own image prompt names no place (see pickSceneArt). The illustrations are
 * the existing local set in SCENE_ART, so a sub-genre changes which picture is shown, not how pictures are made.
 */
export const SUBGENRE_DEFAULT_ART: Record<SubgenreId, SceneArtId> = {
  paranormal: "house",
  ghost: "figure",
  "haunted-house": "house",
  possession: "door",
  psychological: "door",
  folk: "forest",
  cosmic: "lighthouse",
  slasher: "forest",
  gothic: "house",
  creature: "water",
  cult: "forest",
  survival: "water",
};
