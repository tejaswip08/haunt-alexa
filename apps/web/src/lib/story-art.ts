/** The cover artwork for a story. The same mapping as the Fire TV app, so a story gets the same picture on both. */
const CARD_ART = [
  "/art/ashford-house.svg",
  "/art/asylum.svg",
  "/art/forest.svg",
  "/art/ship.svg",
  "/art/village.svg",
  "/art/hallway.svg",
  "/art/cabin.svg",
  "/art/cosmic.svg",
];

export function artForStoryId(storyId: string): string {
  let hash = 0;
  for (const ch of storyId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return CARD_ART[hash % CARD_ART.length]!;
}
