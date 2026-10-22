import express, { type Request, type Response, Router } from "express";
import { describeAwsError } from "./aws-errors.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { isFirstParty } from "./request-guards.ts";
import type { SpeechToText } from "./stt.ts";
import { AudioFormatError, parseWav } from "./wav.ts";

export interface TranscribeRouteOptions {
  speechToText: SpeechToText | undefined;
  limiter: RateLimiter;
  /** Longest answer accepted, in seconds. */
  maxSeconds?: number;
  /** Shortest clip worth sending, in seconds. */
  minSeconds?: number;
  /** Origins allowed besides the server's own (e.g. a deployed web app on another host). */
  extraOrigins?: string[];
  languageCode?: string;
  timeoutMs?: number;
}

/** 16 kHz mono 16-bit is 32 KB/s; the cap leaves room for 48 kHz at the maximum length. */
export const MAX_UPLOAD_BYTES = 48_000 * 2 * 15 + 1024;

/**
 * POST /api/transcribe — body: a WAV recording (audio/wav). Returns { transcript }.
 * The transcript goes back to the client for the listener to confirm; this route never
 * talks to the story engine.
 */
export function createTranscribeRouter(options: TranscribeRouteOptions): Router {
  const { speechToText, limiter, maxSeconds = 15, minSeconds = 0.3, languageCode = "en-US", timeoutMs = 20_000 } = options;
  const router = Router();

  router.post(
    "/",
    (req, res, next) => {
      if (!speechToText) return void res.status(503).json({ error: "Server speech recognition is off.", code: "disabled" });
      if (!isFirstParty(req, { name: "x-haunt-client", value: "voice" }, options.extraOrigins ?? [])) {
        return void res.status(403).json({ error: "Recordings are only accepted from Haunt's own pages.", code: "origin" });
      }
      const type = (req.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "audio/wav" && type !== "audio/x-wav" && type !== "audio/wave") {
        return void res.status(415).json({ error: "Send the recording as audio/wav.", code: "content-type" });
      }
      const declared = Number(req.get("content-length") ?? "0");
      if (declared > MAX_UPLOAD_BYTES) return void res.status(413).json({ error: "That recording is too long.", code: "too-large" });
      const limit = limiter.hit(req.ip ?? "unknown");
      if (!limit.ok) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
        return void res.status(429).json({ error: "Too many voice answers at once. Wait a moment.", code: "rate-limited" });
      }
      next();
    },
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (req: Request, res: Response) => {
      const started = Date.now();
      let audio;
      try {
        audio = parseWav(new Uint8Array(req.body as Buffer));
      } catch (error) {
        if (error instanceof AudioFormatError) return void res.status(400).json({ error: error.message, code: error.code });
        throw error;
      }
      if (audio.durationSeconds > maxSeconds) {
        return void res.status(413).json({ error: `Answers can be up to ${maxSeconds} seconds.`, code: "too-long" });
      }
      if (audio.durationSeconds < minSeconds) {
        return void res.json({ transcript: "", seconds: round(audio.durationSeconds) });
      }
      try {
        const transcript = await speechToText!.transcribe(audio, { languageCode, signal: AbortSignal.timeout(timeoutMs) });
        // Log sizes and timing only: never the audio or what was said.
        console.log(
          `[stt] ${speechToText!.name}: ${round(audio.durationSeconds)} s at ${audio.sampleRate} Hz → ${transcript.length} chars in ${Date.now() - started} ms`,
        );
        res.json({ transcript, seconds: round(audio.durationSeconds) });
      } catch (error) {
        console.error(`[stt] ${speechToText!.name} failed:`, (error as Error).name);
        const { status, reason } = describeAwsError(error, "Speech recognition");
        res.status(status).json({ error: reason, code: "service" });
      }
    },
  );

  // Oversized bodies that slipped past the Content-Length check (e.g. chunked uploads).
  router.use((error: { type?: string; status?: number }, _req: Request, res: Response, next: (e: unknown) => void) => {
    if (error?.type === "entity.too.large") return void res.status(413).json({ error: "That recording is too long.", code: "too-large" });
    next(error);
  });
  return router;
}


const round = (n: number) => Math.round(n * 10) / 10;
