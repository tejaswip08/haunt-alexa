import { createHash } from "node:crypto";
import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from "@aws-sdk/client-polly";
import { config } from "./config.ts";

let polly: PollyClient | undefined;

/** Polly's generative engine accepts up to 3,000 characters per request. Requests above this are rejected by the route. */
export const MAX_TTS_CHARS = 3000;
/** Each Polly call stays well under the limit, split on sentence boundaries. */
const CHUNK_CHARS = 2400;
const CALL_TIMEOUT_MS = 20_000;
const CACHE_ENTRIES = 300;
/** Pauses between paragraphs and at dashes. Kept short: a longer pause on every sentence reads as stilted. */
const PARAGRAPH_BREAK = "600ms";
const DASH_BREAK = "250ms";

/** Synthesis configuration, part of every cache key so a voice or engine change never serves old audio. */
function settings() {
  return {
    voice: config.pollyVoice,
    engine: config.pollyEngine,
    ssml: config.pollySsml,
    language: config.pollyLanguage,
  };
}

/** Escapes text for XML, so a quote, ampersand, or angle bracket in a story can't break or inject SSML. */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Wraps narration in SSML: a short pause between paragraphs, a brief one at dashes, and nothing added between ordinary sentences.
 * The words are the story's own; only the pauses are added.
 */
export function toSsml(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const body = paragraphs
    .map((p) => xmlEscape(p).replace(/\s*[—–]\s*/g, `<break time="${DASH_BREAK}"/>`))
    .join(`<break time="${PARAGRAPH_BREAK}"/>`);
  // A slower delivery reads as more deliberate and unsettling. Generative Kenneth accepts rate only (not pitch or whisper).
  return `<speak><prosody rate="88%">${body}</prosody></speak>`;
}

/** Splits long narration on sentence boundaries, never mid-sentence, into pieces of at most `max` characters. */
export function splitForPolly(text: string, max = CHUNK_CHARS): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > max) {
      // A single over-long sentence (rare): split on spaces so no call exceeds the limit.
      if (current) chunks.push(current);
      current = "";
      let piece = "";
      for (const word of sentence.split(/\s+/)) {
        if (piece && piece.length + word.length + 1 > max) {
          chunks.push(piece);
          piece = word;
        } else {
          piece = piece ? `${piece} ${word}` : word;
        }
      }
      if (piece) chunks.push(piece);
      continue;
    }
    if (current && current.length + sentence.length + 1 > max) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Errors that mean the server's AWS setup is unusable (missing or expired credentials). The route reports them as unavailable. */
export class NarrationUnavailableError extends Error {
  constructor(message = "Narration is unavailable: the server's AWS credentials are missing or expired.") {
    super(message);
    this.name = "NarrationUnavailableError";
  }
}

const CREDENTIAL_ERRORS = new Set(["CredentialsProviderError", "UnrecognizedClientException", "ExpiredTokenException", "InvalidSignatureException", "AccessDeniedException"]);

async function callPolly(text: string, ssml: boolean): Promise<Uint8Array> {
  polly ??= new PollyClient({ region: config.awsRegion });
  const { voice, engine, language } = settings();
  const output = await polly.send(
    new SynthesizeSpeechCommand({
      Text: ssml ? toSsml(text) : text,
      TextType: ssml ? "ssml" : "text",
      OutputFormat: "mp3",
      VoiceId: voice as VoiceId,
      Engine: engine as Engine,
      LanguageCode: language as never,
    }),
    { abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
  );
  if (!output.AudioStream) throw new Error("Polly returned no audio.");
  return output.AudioStream.transformToByteArray();
}

/** One chunk: SSML first, and plain text only if Polly rejects the SSML for this chunk. Other failures are not retried here. */
async function synthesizeChunk(text: string): Promise<Uint8Array> {
  if (!settings().ssml) return callPolly(text, false);
  try {
    return await callPolly(text, true);
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "InvalidSsmlException" || name === "TextLengthExceededException") {
      console.warn("[tts] SSML rejected for one chunk; using plain text for it");
      return callPolly(text, false);
    }
    throw error;
  }
}

async function synthesizeAll(text: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const chunk of splitForPolly(text)) parts.push(await synthesizeChunk(chunk));
  // MP3 frames can be concatenated directly; Polly returns each chunk as its own MP3 stream.
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Completed audio by key. Identical requests share one synthesis, including concurrent ones. A failure is not cached, so a
 * later request tries again.
 */
const cache = new Map<string, Promise<Uint8Array>>();

function cacheKey(text: string): string {
  return createHash("sha256").update(JSON.stringify({ v: 1, text, ...settings() })).digest("hex");
}

/** Narrate text with Amazon Polly. Returns MP3 bytes. Cached in memory for this process; never written to disk or the browser. */
export async function synthesize(text: string): Promise<Uint8Array> {
  const key = cacheKey(text);
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = synthesizeAll(text).catch((error) => {
    cache.delete(key);
    const name = (error as { name?: string }).name ?? "";
    if (CREDENTIAL_ERRORS.has(name)) throw new NarrationUnavailableError();
    throw error;
  });
  cache.set(key, pending);
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
  return pending;
}
