import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { downsample, encodeWav, floatTo16 } from "../src/lib/pcm.ts";
import { chooseEngine, describeListenFailure, ListenError } from "../src/lib/recognition.ts";
import { recordAnswer, type AudioContextLike } from "../src/lib/recorder.ts";
import { transcribeOnServer } from "../src/lib/server-stt.ts";

/** A fake microphone: plays `blocks` of samples (loud or quiet) through the recorder. */
function fakeAudio(blocks: number[], sampleRate = 48000) {
  const stopped: string[] = [];
  let processor: ReturnType<AudioContextLike["createScriptProcessor"]> | undefined;
  const stream = { getTracks: () => [{ stop: () => stopped.push("track") }] } as unknown as MediaStream;
  const context: AudioContextLike = {
    sampleRate,
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => (processor = { onaudioprocess: null, connect() {}, disconnect() {} }),
    close: async () => void stopped.push("context"),
  };
  const play = async () => {
    await new Promise((r) => setTimeout(r, 0));
    for (const level of blocks) {
      const data = new Float32Array(4800).fill(level); // 0.1 s at 48 kHz
      processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } });
    }
  };
  return { deps: { getUserMedia: async () => stream, createContext: () => context }, play, stopped };
}

const loud = 0.2;
const quiet = 0;

describe("Recording an answer", () => {
  it("records until a pause after speech, as 16 kHz mono WAV, and releases the microphone", async () => {
    const audio = fakeAudio([quiet, loud, loud, loud, ...Array(14).fill(quiet)]);
    const handle = recordAnswer(audio.deps, { silenceSeconds: 1.3 });
    await audio.play();
    const recording = await handle.done;
    assert.equal(recording.heardSpeech, true);
    const view = new DataView(recording.wav.buffer);
    assert.equal(String.fromCharCode(...recording.wav.subarray(0, 4)), "RIFF");
    assert.equal(view.getUint32(24, true), 16000, "sample rate");
    assert.equal(view.getUint16(22, true), 1, "mono");
    assert.ok(recording.seconds > 1.5 && recording.seconds < 1.9, `stopped after the pause (${recording.seconds}s)`);
    assert.deepEqual(audio.stopped.sort(), ["context", "track"]);
  });

  it("stops at the maximum length", async () => {
    const audio = fakeAudio(Array(200).fill(loud));
    const handle = recordAnswer(audio.deps, { maxSeconds: 2 });
    await audio.play();
    const { seconds } = await handle.done;
    assert.ok(seconds <= 2.05, `capped at ${seconds}s`);
  });

  it("reports silence as no-speech", async () => {
    const audio = fakeAudio(Array(70).fill(quiet));
    const handle = recordAnswer(audio.deps, { noSpeechSeconds: 6 });
    await audio.play();
    await assert.rejects(handle.done, (e: ListenError) => e.code === "no-speech");
  });

  it("maps a refused microphone to not-allowed and a missing one to audio-capture", async () => {
    const refuse = (name: string) =>
      recordAnswer({ getUserMedia: async () => Promise.reject(Object.assign(new Error(name), { name })) }).done;
    await assert.rejects(refuse("NotAllowedError"), (e: ListenError) => e.code === "not-allowed");
    await assert.rejects(refuse("NotFoundError"), (e: ListenError) => e.code === "audio-capture");
    await assert.rejects(refuse("SecurityError"), (e: ListenError) => e.code === "insecure");
  });

  it("reports unsupported recording when Web Audio can't start", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const handle = recordAnswer({
      getUserMedia: async () => stream,
      createContext: () => {
        throw new Error("no audio");
      },
    });
    await assert.rejects(handle.done, (e: ListenError) => e.code === "unsupported");
  });

  it("can be cancelled, discarding the audio", async () => {
    const audio = fakeAudio([loud, loud]);
    const handle = recordAnswer(audio.deps);
    await audio.play();
    handle.cancel();
    await assert.rejects(handle.done, (e: ListenError) => e.code === "aborted");
    assert.ok(audio.stopped.includes("track"), "microphone released");
  });
});

describe("Sending the recording to Haunt's server", () => {
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it("returns the transcript and sends Haunt's header", async () => {
    let sent: RequestInit | undefined;
    const text = await transcribeOnServer(new Uint8Array(10), (async (_url: string, init: RequestInit) => {
      sent = init;
      return new Response(JSON.stringify({ transcript: " Follow them now " }), { status: 200 });
    }) as typeof fetch);
    assert.equal(text, "Follow them now");
    assert.equal((sent!.headers as Record<string, string>)["X-Haunt-Client"], "voice");
    assert.equal((sent!.headers as Record<string, string>)["Content-Type"], "audio/wav");
  });

  it("returns an empty transcript as empty", async () => {
    assert.equal(await transcribeOnServer(new Uint8Array(10), reply(200, { transcript: "" }) as typeof fetch), "");
  });

  it("maps server errors to listener-facing codes", async () => {
    const codeFor = async (status: number, body: unknown) => {
      try {
        await transcribeOnServer(new Uint8Array(10), reply(status, body) as typeof fetch);
        return "ok";
      } catch (e) {
        return (e as ListenError).code;
      }
    };
    assert.equal(await codeFor(429, { code: "rate-limited" }), "rate-limited");
    assert.equal(await codeFor(413, { code: "too-long" }), "too-long");
    assert.equal(await codeFor(400, { code: "not-wav" }), "bad-audio");
    assert.equal(await codeFor(503, { code: "disabled" }), "server-off");
    assert.equal(await codeFor(503, { code: "service" }), "server-error");
    assert.match(describeListenFailure("rate-limited").message, /Wait a minute/);
  });

  it("reports an unreachable server and a cancelled upload", async () => {
    await assert.rejects(
      transcribeOnServer(new Uint8Array(1), (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch),
      (e: ListenError) => e.code === "server-unreachable",
    );
    await assert.rejects(
      transcribeOnServer(new Uint8Array(1), (async () => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" }))) as typeof fetch),
      (e: ListenError) => e.code === "aborted",
    );
  });
});

describe("Choosing a recognizer", () => {
  const base = { android: false, browserRecognition: true, browserHasService: true, browserFailed: false, serverAvailable: true, canRecord: true };

  it("keeps the free browser recognizer where it works", () => {
    assert.equal(chooseEngine(base), "browser");
  });

  it("uses the server in browsers without a speech service (e.g. Brave), or after a network failure", () => {
    assert.equal(chooseEngine({ ...base, browserHasService: false }), "server");
    assert.equal(chooseEngine({ ...base, browserFailed: true }), "server");
  });

  it("prefers Android's recognizer inside the Fire TV app", () => {
    assert.equal(chooseEngine({ ...base, android: true }), "android");
  });

  it("has no engine when nothing can work", () => {
    assert.equal(chooseEngine({ ...base, browserRecognition: false, serverAvailable: false }), undefined);
    assert.equal(chooseEngine({ ...base, browserFailed: true, serverAvailable: false }), undefined);
  });
});

describe("Audio encoding", () => {
  it("downsamples 48 kHz to 16 kHz and clamps samples", () => {
    assert.equal(downsample(new Float32Array(48000), 48000).length, 16000);
    assert.deepEqual([...floatTo16(new Float32Array([2, -2, 0]))], [32767, -32768, 0]);
    const wav = encodeWav(new Int16Array(16000));
    assert.equal(wav.byteLength, 44 + 32000);
  });
});
