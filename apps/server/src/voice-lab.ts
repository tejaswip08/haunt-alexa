import { PollyClient, SynthesizeSpeechCommand, type Engine, type VoiceId } from "@aws-sdk/client-polly";
import { Router, type Request, type Response } from "express";
import { z } from "zod";

/**
 * Voice audition (development only). Mounted only when HAUNT_VOICE_LAB=1 and NODE_ENV is not production.
 * It synthesizes the same text with a chosen provider, model and voice, so listeners can compare real audio.
 *
 *   GET  /api/voice-lab/providers     which providers have credentials here (booleans only; never the values)
 *   POST /api/voice-lab/synthesize    { provider, model, voice, text } -> audio/mpeg
 *
 * A provider without its key answers 412 and nothing is sent to it. No provider is silently substituted.
 */

const MAX_CHARS = 3000;
const TIMEOUT_MS = 30_000;

/** The providers and their keys (environment names only). Values are read on each call and never returned or logged. */
const KEYS = {
  openai: "OPENAI_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  google: "GOOGLE_TTS_API_KEY",
} as const;

const RequestSchema = z.object({
  provider: z.enum(["polly", "openai", "elevenlabs", "google"]),
  model: z.string().trim().min(1).max(80),
  voice: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(MAX_CHARS),
});

function fail(res: Response, status: number, error: string) {
  res.status(status).json({ error });
}

async function pollyAudio(model: string, voice: string, text: string): Promise<Uint8Array> {
  const client = new PollyClient({ region: process.env.AWS_REGION ?? "us-east-1" });
  const out = await client.send(
    new SynthesizeSpeechCommand({ Text: text, OutputFormat: "mp3", VoiceId: voice as VoiceId, Engine: model as Engine, LanguageCode: "en-US" }),
    { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!out.AudioStream) throw new Error("Polly returned no audio.");
  return out.AudioStream.transformToByteArray();
}

async function openaiAudio(model: string, voice: string, text: string, key: string): Promise<Uint8Array> {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI answered ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function elevenlabsAudio(model: string, voice: string, text: string, key: string): Promise<Uint8Array> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ElevenLabs answered ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function googleAudio(model: string, voice: string, text: string, key: string): Promise<Uint8Array> {
  const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: "en-US", name: voice, ...(model ? { modelName: model } : {}) },
      audioConfig: { audioEncoding: "MP3" },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google answered ${response.status}.`);
  const data = (await response.json()) as { audioContent?: string };
  if (!data.audioContent) throw new Error("Google returned no audio.");
  return new Uint8Array(Buffer.from(data.audioContent, "base64"));
}

export function createVoiceLabRouter(): Router {
  const router = Router();

  router.get("/providers", (_req: Request, res: Response) => {
    res.json({
      polly: { configured: Boolean(process.env.AWS_REGION || process.env.AWS_PROFILE || process.env.AWS_ACCESS_KEY_ID) },
      openai: { configured: Boolean(process.env[KEYS.openai]) },
      elevenlabs: { configured: Boolean(process.env[KEYS.elevenlabs]) },
      google: { configured: Boolean(process.env[KEYS.google]) },
    });
  });

  router.post("/synthesize", async (req: Request, res: Response) => {
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "Choose a provider, model, voice, and text of up to 3,000 characters.");
    const { provider, model, voice, text } = parsed.data;
    try {
      let audio: Uint8Array;
      if (provider === "polly") {
        audio = await pollyAudio(model, voice, text);
      } else {
        const key = process.env[KEYS[provider]];
        if (!key) return fail(res, 412, `${provider} needs its API key set on this server (${KEYS[provider]}). Nothing was sent.`);
        audio =
          provider === "openai"
            ? await openaiAudio(model, voice, text, key)
            : provider === "elevenlabs"
              ? await elevenlabsAudio(model, voice, text, key)
              : await googleAudio(model, voice, text, key);
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      res.send(Buffer.from(audio));
    } catch (error) {
      // Provider messages are reduced to a status line; they can echo request details, so the raw text is not returned.
      const message = error instanceof Error ? error.message.replace(/key[^\s]*/gi, "[hidden]") : "Synthesis failed.";
      console.error(`[voice-lab] ${provider} failed: ${(error as Error).name}`);
      fail(res, 502, message);
    }
  });

  return router;
}
