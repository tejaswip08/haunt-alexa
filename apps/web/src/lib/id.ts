/** A random id. `crypto.randomUUID` only exists on HTTPS pages, and a TV on the local network loads Haunt over HTTP. */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
