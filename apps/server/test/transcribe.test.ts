import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createRateLimiter } from "../src/rate-limit.ts";
import { createMockSpeechToText, createTranscribeSpeechToText, type SpeechToText } from "../src/stt.ts";
import { createTranscribeRouter, MAX_UPLOAD_BYTES } from "../src/transcribe-route.ts";
import { AudioFormatError, parseWav } from "../src/wav.ts";

/** A mono 16-bit PCM WAV of `seconds` of quiet noise. */
function wav(seconds: number, { sampleRate = 16000, channels = 1, bits = 16, encoding = 1 } = {}): Uint8Array {
  const dataBytes = Math.round(seconds * sampleRate) * channels * (bits / 8);
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const put = (at: number, text: string) => [...text].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, encoding, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  put(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 44; i < out.length; i++) out[i] = (i * 31) & 0xff;
  return out;
}

describe("WAV parsing", () => {
  it("reads format and computes duration from the bytes", () => {
    const audio = parseWav(wav(2));
    assert.equal(audio.sampleRate, 16000);
    assert.equal(audio.durationSeconds, 2);
    assert.equal(audio.pcm.byteLength, 64000);
  });

  it("rejects non-WAV, stereo, 8-bit, compressed and truncated audio", () => {
    const code = (bytes: Uint8Array) => {
      try {
        parseWav(bytes);
        return "ok";
      } catch (e) {
        return (e as AudioFormatError).code;
      }
    };
    assert.equal(code(new TextEncoder().encode("\x1aE\xdf\xa3 webm".padEnd(64, " "))), "not-wav");
    assert.equal(code(wav(1, { channels: 2 })), "unsupported-encoding");
    assert.equal(code(wav(1, { bits: 8 })), "unsupported-encoding");
    assert.equal(code(wav(1, { encoding: 3 })), "unsupported-encoding");
    assert.equal(code(wav(1, { sampleRate: 12345 })), "unsupported-encoding");
    assert.equal(code(wav(1).subarray(0, 2000)), "truncated");
    assert.equal(code(wav(0)), "empty");
  });
});

describe("Rate limiting", () => {
  it("allows a burst up to the limit, then asks the client to wait", () => {
    const limiter = createRateLimiter([{ windowMs: 60_000, max: 2 }]);
    assert.equal(limiter.hit("a", 0).ok, true);
    assert.equal(limiter.hit("a", 1000).ok, true);
    const third = limiter.hit("a", 2000);
    assert.equal(third.ok, false);
    assert.ok(!third.ok && third.retryAfterSeconds >= 58);
    assert.equal(limiter.hit("b", 2000).ok, true, "other clients are unaffected");
    assert.equal(limiter.hit("a", 61_000).ok, true, "the window slides");
  });
});

describe("POST /api/transcribe (mocked speech to text)", () => {
  let base = "";
  let server: ReturnType<express.Express["listen"]>;
  const calls: { seconds: number }[] = [];
  let next: (() => Promise<string>) | undefined;
  const fake: SpeechToText = {
    name: "fake",
    async transcribe({ pcm, sampleRate }) {
      calls.push({ seconds: pcm.byteLength / (sampleRate * 2) });
      return next ? next() : "I follow the call buttons";
    },
  };

  before(async () => {
    const app = express();
    app.use("/api/transcribe", createTranscribeRouter({ speechToText: fake, limiter: createRateLimiter([{ windowMs: 60_000, max: 8 }]) }));
    app.use("/off", createTranscribeRouter({ speechToText: undefined, limiter: createRateLimiter([{ windowMs: 1, max: 1 }]) }));
    server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const post = (body: Uint8Array | string, headers: Record<string, string> = {}, path = "/api/transcribe") =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "audio/wav", "x-haunt-client": "voice", ...headers },
      body: typeof body === "string" ? body : Buffer.from(body),
    });

  it("returns the transcript for a valid recording, without touching the story", async () => {
    const res = await post(wav(2));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { transcript: "I follow the call buttons", seconds: 2 });
    assert.equal(calls.at(-1)?.seconds, 2, "duration comes from the audio, not the client");
  });

  it("returns an empty transcript for a clip too short to contain speech", async () => {
    const before = calls.length;
    const res = await post(wav(0.1));
    assert.deepEqual(await res.json(), { transcript: "", seconds: 0.1 });
    assert.equal(calls.length, before, "too-short clips are never sent to the paid service");
  });

  it("passes through an empty transcript when nothing was said", async () => {
    next = async () => "";
    const res = await post(wav(1));
    next = undefined;
    assert.equal((await res.json()).transcript, "");
  });

  it("rejects audio that isn't the declared format", async () => {
    const res = await post("this is not audio at all, just a string pretending to be one....");
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "not-wav");
  });

  it("rejects the wrong content type", async () => {
    const res = await post(wav(1), { "content-type": "audio/webm" });
    assert.equal(res.status, 415);
  });

  it("rejects recordings that are too long or too large", async () => {
    const long = await post(wav(16));
    assert.equal(long.status, 413);
    assert.equal((await long.json()).code, "too-long");
    const huge = await post(new Uint8Array(MAX_UPLOAD_BYTES + 10));
    assert.equal(huge.status, 413);
    assert.equal((await huge.json()).code, "too-large");
  });

  it("rejects other sites and requests without Haunt's header", async () => {
    assert.equal((await post(wav(1), { origin: "https://evil.example" })).status, 403);
    assert.equal((await post(wav(1), { "x-haunt-client": "" })).status, 403);
  });

  it("rate-limits a client that sends too many recordings", async () => {
    let status = 200;
    let retryAfter: string | null = null;
    for (let i = 0; i < 12 && status !== 429; i++) {
      const res = await post(wav(0.1));
      status = res.status;
      retryAfter = res.headers.get("retry-after");
    }
    assert.equal(status, 429);
    assert.ok(Number(retryAfter) > 0);
  });

  it("reports when server recognition is off", async () => {
    const res = await post(wav(1), {}, "/off");
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, "disabled");
  });
});

describe("Speech-to-text adapters", () => {
  it("mock returns a fixed sentence, and nothing for near-silence", async () => {
    const stt = createMockSpeechToText("Hello");
    const opts = { languageCode: "en-US", signal: AbortSignal.timeout(1000) };
    assert.equal(await stt.transcribe({ pcm: new Uint8Array(32000), sampleRate: 16000 }, opts), "Hello");
    assert.equal(await stt.transcribe({ pcm: new Uint8Array(1000), sampleRate: 16000 }, opts), "");
  });

  it("Transcribe adapter streams 100 ms PCM chunks and joins final results only", async () => {
    let sent: { input: { MediaEncoding?: string; MediaSampleRateHertz?: number; LanguageCode?: string; AudioStream?: AsyncIterable<{ AudioEvent?: { AudioChunk?: Uint8Array } }> } } | undefined;
    const chunkSizes: number[] = [];
    const client = {
      send: async (command: never) => {
        sent = command;
        for await (const event of sent!.input.AudioStream!) chunkSizes.push(event.AudioEvent!.AudioChunk!.byteLength);
        return {
          TranscriptResultStream: (async function* () {
            yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: true, Alternatives: [{ Transcript: "I fol" }] }] } } };
            yield { TranscriptEvent: { Transcript: { Results: [{ IsPartial: false, Alternatives: [{ Transcript: "I follow them." }] }] } } };
          })(),
        };
      },
    };
    const stt = createTranscribeSpeechToText({ region: "us-east-1", client: client as never });
    const text = await stt.transcribe({ pcm: new Uint8Array(16000), sampleRate: 16000 }, { languageCode: "en-US", signal: AbortSignal.timeout(1000) });
    assert.equal(text, "I follow them.");
    assert.equal(sent!.input.MediaEncoding, "pcm");
    assert.equal(sent!.input.MediaSampleRateHertz, 16000);
    assert.deepEqual(chunkSizes, [3200, 3200, 3200, 3200, 3200]);
  });
});

describe("Browser and server agree on the audio format", () => {
  it("parses what the web recorder encodes", async () => {
    const { encodeWav } = await import("../../web/src/lib/pcm.ts");
    const audio = parseWav(encodeWav(new Int16Array(24000)));
    assert.equal(audio.sampleRate, 16000);
    assert.equal(audio.durationSeconds, 1.5);
  });
});
