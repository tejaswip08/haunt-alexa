/**
 * Normalizes a typed, pasted or autofilled sign-in code. The server uses this function, and the mobile sign-in page
 * embeds its source (activate-page.ts), so every device gets the same rule with no user-agent checks.
 *
 * Only whitespace and invisible characters are removed: spaces and line breaks, no-break spaces, zero-width and
 * directional marks, and the byte-order mark. Phones add those when they paste or autofill. Every other character
 * stays, so a code with a letter, a dash or a missing digit is still refused by the digit check that follows.
 * Keep this function self-contained (no imports, no closures): the page embeds it as text. The invisible characters
 * are listed by code point so the list survives being embedded.
 */
export function normalizeCode(raw: string): string {
  const invisible = [160, 6158, 8203, 8204, 8205, 8206, 8207, 8232, 8233, 8234, 8235, 8236, 8237, 8238, 8288, 8294, 8295, 8296, 8297, 65279];
  return raw
    .replace(/\s/g, "")
    .split("")
    .filter((character) => !invisible.includes(character.charCodeAt(0)))
    .join("");
}
