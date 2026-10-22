import { ListenError } from "./recognition.ts";

/** Sends a recorded answer to Haunt's server for transcription. Returns the transcript ("" if nothing was heard). */
export async function transcribeOnServer(wav: Uint8Array, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "audio/wav", "X-Haunt-Client": "voice" },
      body: wav as BodyInit,
      signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new ListenError("aborted");
    throw new ListenError("server-unreachable");
  }
  const body = (await response.json().catch(() => ({}))) as { transcript?: string; code?: string; error?: string };
  if (response.ok) return (body.transcript ?? "").trim();
  const code =
    response.status === 429
      ? "rate-limited"
      : response.status === 413
        ? "too-long"
        : response.status === 503 && body.code === "disabled"
          ? "server-off"
          : response.status === 400 || response.status === 415
            ? "bad-audio"
            : "server-error";
  throw new ListenError(code, body.error);
}
