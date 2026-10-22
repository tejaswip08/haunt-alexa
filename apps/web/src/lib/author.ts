/**
 * The author line on a story: "By {name}" when the story has a real creator name, otherwise "Haunt Originals".
 * The name is trimmed first, so a blank or whitespace-only name counts as missing. Same rule as the Fire TV app (apps/tv).
 */
export function authorLabel(creator: string | null | undefined): string {
  const name = creator?.trim();
  return name ? `By ${name}` : "Haunt Originals";
}

/**
 * The author line for a Home card or the featured story. An original already carries its own "HAUNT ORIGINAL" badge, so it
 * gets no author line. Any other story gets "By {name}" only when it has a real creator name. Nothing is invented.
 */
export function homeAuthorLine(creator: string | null | undefined, original: boolean): string | undefined {
  if (original) return undefined;
  const name = creator?.trim();
  return name ? `By ${name}` : undefined;
}
