import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessEnvironment,
  describeListenFailure,
  ListenError,
  recognizeOnce,
  type RecognitionCtor,
  type SpeechRecognitionLike,
  type VoiceEnvironment,
} from "../src/lib/recognition.ts";
import { routeSpokenReply } from "../src/lib/voice-intent.ts";

type Script = (r: SpeechRecognitionLike) => void;

/** A stand-in for the browser recognizer: `script` plays the events a real one would fire. */
function fakeRecognizer(script: Script, options: { throwOnStart?: string } = {}): RecognitionCtor {
  return class implements SpeechRecognitionLike {
    lang = "";
    interimResults = false;
    maxAlternatives = 1;
    continuous = false;
    onstart: (() => void) | null = null;
    onresult: SpeechRecognitionLike["onresult"] = null;
    onerror: SpeechRecognitionLike["onerror"] = null;
    onend: (() => void) | null = null;
    start() {
      if (options.throwOnStart) throw Object.assign(new Error("start"), { name: options.throwOnStart });
      queueMicrotask(() => {
        this.onstart?.();
        script(this);
      });
    }
    stop() {}
    abort() {
      this.onerror?.({ error: "aborted" });
      this.onend?.();
    }
  };
}

const result = (text: string, isFinal: boolean) => Object.assign([{ transcript: text }], { isFinal });
const env = (over: Partial<VoiceEnvironment> = {}): VoiceEnvironment => ({
  hasRecognition: true,
  isSecureContext: true,
  micPermission: "prompt",
  audioInputs: 1,
  brands: ["Google Chrome", "Chromium"],
  ...over,
});

describe("Browser speech recognition", () => {
  it("resolves with the final transcript and reports interim text", async () => {
    const interim: string[] = [];
    const logs: string[] = [];
    const Recognition = fakeRecognizer((r) => {
      r.onresult!({ results: [result("I open the", false)] });
      r.onresult!({ results: [result("I open the basement door", true)] });
      r.onend!();
    });
    const text = await recognizeOnce(Recognition, { onInterim: (t) => interim.push(t), log: (e) => logs.push(e) });
    assert.equal(text, "I open the basement door");
    assert.deepEqual(interim, ["I open the", "I open the basement door"]);
    assert.deepEqual(logs, ["start", "end", "transcript"]);
  });

  it("rejects with the browser's own error code (the cause of the generic message)", async () => {
    const Recognition = fakeRecognizer((r) => {
      r.onerror!({ error: "network" });
      r.onend!();
    });
    await assert.rejects(recognizeOnce(Recognition), (e: ListenError) => e instanceof ListenError && e.code === "network");
  });

  it("reports permission denial", async () => {
    const Recognition = fakeRecognizer((r) => {
      r.onerror!({ error: "not-allowed" });
      r.onend!();
    });
    await assert.rejects(recognizeOnce(Recognition), (e: ListenError) => e.code === "not-allowed");
  });

  it("turns an exception from start() into a ListenError instead of an unknown error", async () => {
    await assert.rejects(recognizeOnce(fakeRecognizer(() => {}, { throwOnStart: "InvalidStateError" })), (e: ListenError) => e.code === "start-failed");
    await assert.rejects(recognizeOnce(fakeRecognizer(() => {}, { throwOnStart: "NotAllowedError" })), (e: ListenError) => e.code === "not-allowed");
  });

  it("treats silence as no-speech and settles only once", async () => {
    let ends = 0;
    const Recognition = fakeRecognizer((r) => {
      r.onend!();
      r.onend!();
      ends++;
    });
    await assert.rejects(recognizeOnce(Recognition), (e: ListenError) => e.code === "no-speech");
    assert.equal(ends, 1);
  });

  it("can be cancelled through the active recognizer", async () => {
    let active: SpeechRecognitionLike | undefined;
    const pending = recognizeOnce(fakeRecognizer(() => {}), { onActive: (r) => (active = r ?? active) });
    active!.abort();
    await assert.rejects(pending, (e: ListenError) => e.code === "aborted");
  });
});

describe("Why voice is unavailable", () => {
  it("names each environment problem", () => {
    assert.equal(assessEnvironment(env({ hasRecognition: false })).problem, "unsupported");
    assert.equal(assessEnvironment(env({ isSecureContext: false })).problem, "insecure");
    assert.equal(assessEnvironment(env({ micPermission: "denied" })).problem, "permission-denied");
    assert.equal(assessEnvironment(env({ audioInputs: 0 })).problem, "no-microphone");
    assert.deepEqual(assessEnvironment(env()), { available: true, message: "" });
    assert.equal(assessEnvironment(env({ audioInputs: null, micPermission: "unknown" })).available, true);
  });

  it("explains each recognition error", () => {
    assert.equal(describeListenFailure("not-allowed").problem, "permission-denied");
    assert.equal(describeListenFailure("not-allowed", { micPermission: "granted" }).problem, "service-unavailable");
    assert.equal(describeListenFailure("audio-capture").problem, "no-microphone");
    assert.equal(describeListenFailure("network").problem, "service-unavailable");
    assert.equal(describeListenFailure("language-not-supported").problem, "language");
    assert.equal(describeListenFailure("no-speech").available, true);
    assert.equal(describeListenFailure("aborted").message, "");
    assert.match(describeListenFailure("bad-grammar").message, /bad-grammar/);
  });

  it("points non-Google Chromium browsers at Google Chrome when the service fails", () => {
    assert.match(describeListenFailure("network", { brands: ["Brave", "Chromium"] }).message, /Google Chrome/);
    assert.match(describeListenFailure("network", { brands: ["Google Chrome", "Chromium"] }).message, /internet connection/);
  });
});

describe("Spoken replies reach the story", () => {
  it("submits an ordinary transcript as the story answer", () => {
    const calls: string[] = [];
    const actions = {
      repeat: () => calls.push("repeat"),
      choices: () => calls.push("choices"),
      end: () => calls.push("end"),
      answer: (text: string) => calls.push(`answer:${text}`),
    };
    routeSpokenReply("Follow the call buttons", actions);
    routeSpokenReply("what are my choices", actions);
    routeSpokenReply("end the story", actions);
    assert.deepEqual(calls, ["answer:Follow the call buttons", "choices", "end"]);
  });
});
