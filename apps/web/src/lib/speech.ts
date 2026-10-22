/**
 * The device's voice and ears. Narration uses Amazon Polly through the Haunt server,
 * falling back to the browser's own voice. Listening uses the browser's speech recognition.
 */

import { randomId } from "./id.ts";
import {
  assessEnvironment,
  consoleVoiceLog,
  ListenError,
  recognizeOnce,
  type RecognitionCtor,
  type SpeechRecognitionLike,
  type VoiceEngine,
  type VoiceEnvironment,
  type VoiceStatus,
  chooseEngine,
  lacksSpeechService,
} from "./recognition.ts";
import { canRecord, recordAnswer, type RecorderHandle } from "./recorder.ts";
import { transcribeOnServer } from "./server-stt.ts";
import { session } from "./session.ts";

export { ListenError } from "./recognition.ts";

let serverVoice = true;

/**
 * How one narration ended. "ended": every word was spoken. "cancelled": it was stopped on purpose (a pause that the voice
 * can't hold, a choice, leaving the story, or a newer narration). Only "ended" means the story may move on.
 */
export type NarrationEnd = "ended" | "cancelled";

/** One piece of narration. It settles once. Callbacks from a voice that has been cancelled are ignored. */
export interface Narration {
  done: Promise<NarrationEnd>;
  /** Holds the words where they are. False when the voice can't do that; the caller then cancels and starts over on resume. */
  pause(): boolean;
  /** Continues a pause. False when nothing is paused. */
  resume(): boolean;
  cancel(): void;
}

/** The voice actually speaking one narration. */
interface Voice {
  pause(): boolean;
  resume(): boolean;
  stop(): void;
}

/** The narration currently speaking, so stopSpeaking can end it. Only one narration speaks at a time. */
let active: Narration | undefined;

export function stopSpeaking() {
  active?.cancel();
  active = undefined;
}

/** Pauses the narration where it is. Returns false when nothing is speaking or the voice can't hold its place. */
export function pauseSpeaking(): boolean {
  return active?.pause() ?? false;
}

/** Resumes a narration paused by pauseSpeaking. Returns false when nothing is paused. */
export function resumeSpeaking(): boolean {
  return active?.resume() ?? false;
}

/** Text-to-speech exposed by the Fire TV app shell (Android TextToSpeech), when running inside it. */
interface NativeVoice {
  speak(text: string, id: string): void;
  stop(): void;
  /** Android SpeechRecognizer, present only when the device has a speech recognition service. */
  canListen?(): boolean;
  listen?(id: string): void;
  stopListening?(): void;
}
const nativeVoice = (window as unknown as { HauntNative?: NativeVoice }).HauntNative;
const nativeDone = new Map<string, () => void>();
(window as unknown as { hauntSpeechDone?: (id: string) => void }).hauntSpeechDone = (id) => {
  nativeDone.get(id)?.();
  nativeDone.delete(id);
};

/**
 * Narrates `text`. The returned narration settles "ended" only when the voice finishes it. Starting a narration stops the
 * one before it (that one settles "cancelled").
 */
export function narrate(text: string): Narration {
  stopSpeaking();
  let settle!: (end: NarrationEnd) => void;
  const done = new Promise<NarrationEnd>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  let voice: Voice | undefined;
  // A pause requested before the voice is ready is kept, so the voice starts paused.
  let wantPaused = false;
  const finish = (end: NarrationEnd) => {
    if (settled) return;
    settled = true;
    if (active === narration) active = undefined;
    settle(end);
  };
  const narration: Narration = {
    done,
    pause() {
      if (settled) return false;
      wantPaused = true;
      return voice ? voice.pause() : true;
    },
    resume() {
      if (settled || !wantPaused) return false;
      wantPaused = false;
      return voice ? voice.resume() : true;
    },
    cancel() {
      if (settled) return;
      voice?.stop();
      finish("cancelled");
    },
  };
  active = narration;

  const useVoice = (created: Voice) => {
    voice = created;
    if (wantPaused) voice.pause();
  };
  /** A voice failed partway: the part is read again on the device voice, so nothing is skipped. */
  const fallBack = (): Promise<void> => {
    const device = browserVoice(text, (end) => finish(end), useVoice);
    return device ? Promise.resolve() : Promise.resolve(finish("ended"));
  };

  void (async () => {
    if (!text.trim()) return finish("ended");
    if (nativeVoice) return nativeNarration(nativeVoice, text, finish, useVoice);
    if (serverVoice) {
      const polly = await pollyNarration(text, finish, useVoice);
      if (polly === "done") return;
      if (polly === "cancelled") return;
      // The server voice is unavailable (or failed before it could speak): use the device voice from here on.
      serverVoice = false;
      console.info("[speech] Server narration unavailable, using the device voice.");
    }
    void fallBack();
  })();
  return narration;
}

/** Speaks `text` and resolves when it has finished or been stopped. Callers that need the difference use narrate. */
export async function speak(text: string): Promise<void> {
  await narrate(text).done;
}

/** Server narration (Polly). Returns "done" when it spoke, "cancelled" when stopped, "unavailable" when it couldn't start. */
async function pollyNarration(
  text: string,
  finish: (end: NarrationEnd) => void,
  useVoice: (voice: Voice) => void,
): Promise<"done" | "cancelled" | "unavailable"> {
  const controller = new AbortController();
  const audio = new Audio();
  let paused = false;
  let url: string | undefined;
  const voice: Voice = {
    pause: () => {
      paused = true;
      audio.pause();
      return true;
    },
    resume: () => {
      paused = false;
      if (audio.src) void audio.play().catch(() => finish("ended"));
      return true;
    },
    stop: () => {
      controller.abort();
      audio.pause();
      if (url) URL.revokeObjectURL(url);
    },
  };
  useVoice(voice);
  let response: Response;
  try {
    // Signed in, so the deployed server narrates with Polly; a guest there falls back to the browser voice.
    response = await session.fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
  } catch {
    return controller.signal.aborted ? "cancelled" : "unavailable";
  }
  if (!response.ok) return "unavailable";
  url = URL.createObjectURL(await response.blob());
  if (controller.signal.aborted) {
    URL.revokeObjectURL(url);
    return "cancelled";
  }
  const ended = new Promise<"ended" | "failed">((resolve) => {
    audio.onended = () => resolve("ended");
    audio.onerror = () => resolve("failed");
  });
  audio.src = url;
  if (!paused) void audio.play().catch(() => undefined);
  const outcome = await ended;
  URL.revokeObjectURL(url);
  if (controller.signal.aborted) return "cancelled";
  if (outcome === "ended") {
    finish("ended");
    return "done";
  }
  // Playback failed partway. Nothing has been finished, so the device voice reads the whole part.
  return "unavailable";
}

/** The device's own voice, through the browser. Returns false when the browser has no speech synthesis. */
function browserVoice(text: string, finish: (end: NarrationEnd) => void, useVoice: (voice: Voice) => void): boolean {
  if (!("speechSynthesis" in window)) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.92;
  utterance.pitch = 0.85;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  utterance.voice = voices.find((v) => /daniel|alex|male|guy/i.test(v.name)) ?? voices[0] ?? null;
  let cancelled = false;
  useVoice({
    pause: () => {
      speechSynthesis.pause();
      return true;
    },
    resume: () => {
      speechSynthesis.resume();
      return true;
    },
    stop: () => {
      cancelled = true;
      speechSynthesis.cancel();
    },
  });
  utterance.onend = () => {
    if (!cancelled) finish("ended");
  };
  // An error the narration didn't cause (not our own cancel) would leave the story stuck. Read the part for its length instead.
  utterance.onerror = () => {
    if (cancelled) return;
    const readingMs = 2500 + text.split(/\s+/).length * 350;
    setTimeout(() => {
      if (!cancelled) finish("ended");
    }, readingMs);
  };
  speechSynthesis.speak(utterance);
  return true;
}

/** The Fire TV shell's voice. It can't pause in place, so pausing reports false. */
function nativeNarration(voice: NativeVoice, text: string, finish: (end: NarrationEnd) => void, useVoice: (voice: Voice) => void) {
  const id = randomId();
  nativeDone.set(id, () => finish("ended"));
  useVoice({
    pause: () => false,
    resume: () => false,
    stop: () => {
      voice.stop();
      nativeDone.delete(id);
    },
  });
  voice.speak(text, id);
}

/** The browser's recognizer, looked up on each use (so tests and diagnostics can swap it in). */
function browserRecognition(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}
const Recognition = browserRecognition();

const nativeEars = nativeVoice?.canListen?.() ? nativeVoice : undefined;

/** True when this device can turn speech into text: the browser's recognizer, or Android's inside the Fire TV app. */
/**
 * Browsers only allow the microphone on secure pages (HTTPS or localhost). Over plain HTTP
 * on a network address the recognizer exists but always fails with "not-allowed".
 */
const browserEars = Recognition !== undefined && window.isSecureContext;

export const canListen = nativeEars !== undefined || browserEars || canRecord();

/** Why voice input is off here, in words a listener can act on. Empty when it's available. */
export const voiceUnavailableReason = canListen
  ? ""
  : Recognition !== undefined
    ? "Voice input needs a secure page: open Haunt at localhost or over HTTPS."
    : (window as unknown as { HauntNative?: unknown }).HauntNative
      ? "This device has no speech recognition service. Use the remote to choose."
      : "This browser has no speech recognition. Try Chrome, Edge or Safari.";

const nativeHeard = new Map<string, (text: string | null, error: string | null) => void>();
(window as unknown as { hauntHeard?: (id: string, text: string | null, error: string | null) => void }).hauntHeard = (
  id,
  text,
  error,
) => {
  nativeHeard.get(id)?.(text, error);
  nativeHeard.delete(id);
};

/** Some recognizers never report silence; give up after this long so the TV can't get stuck listening. */
const NATIVE_LISTEN_TIMEOUT_MS = 12_000;

function listenWithNative(ears: NativeVoice): Promise<string> {
  const id = randomId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!nativeHeard.has(id)) return;
      ears.stopListening?.();
      nativeHeard.get(id)?.(null, "no-speech");
      nativeHeard.delete(id);
    }, NATIVE_LISTEN_TIMEOUT_MS);
    nativeHeard.set(id, (text, error) => {
      clearTimeout(timer);
      if (error) reject(new ListenError(error));
      else if (text?.trim()) resolve(text.trim());
      else reject(new ListenError("no-speech"));
    });
    ears.listen!(id);
  });
}


let activeRecognition: SpeechRecognitionLike | undefined;

export function stopListening() {
  if (nativeEars && nativeHeard.size) {
    nativeEars.stopListening?.();
    for (const [id, done] of nativeHeard) {
      nativeHeard.delete(id);
      done(null, "aborted");
    }
  }
  activeRecording?.cancel();
  activeRecording = undefined;
  activeRecognition?.abort();
  activeRecognition = undefined;
}

let activeRecording: RecorderHandle | undefined;
/** Server speech recognition, as reported by /api/health ("off", "mock" or "transcribe"). */
let serverStt: string = "off";
let serverSttLoaded: Promise<void> | undefined;

/** Learns once per page whether Haunt's server can transcribe recordings. Every page needs this before listening. */
export function loadServerStt(): Promise<void> {
  serverSttLoaded ??= fetch("/api/health")
    .then((response) => response.json() as Promise<{ stt?: string }>)
    .then((health) => void (serverStt = health.stt ?? "off"))
    .catch(() => void (serverStt = "off"));
  return serverSttLoaded;
}
/** Set when the browser's own recognizer failed with "network": later answers go to the server. */
let browserServiceFailed = false;

/** Browser brands (e.g. Brave, Chromium), for choosing a recognizer and explaining failures. */
export function browserBrands(): string[] {
  return (navigator as unknown as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands?.map((b) => b.brand) ?? [];
}

/** Which recognizer the next answer will use. */
export function currentEngine(): VoiceEngine | undefined {
  return chooseEngine({
    android: nativeEars !== undefined,
    browserRecognition: browserRecognition() !== undefined && window.isSecureContext,
    browserHasService: !lacksSpeechService(browserBrands()),
    browserFailed: browserServiceFailed,
    serverAvailable: serverStt !== "off",
    canRecord: canRecord(),
  });
}

/** Stop listening and keep what was heard (a recording is sent; the browser recognizer finalises). */
export function finishListening() {
  if (activeRecording) return activeRecording.finish();
  activeRecognition?.stop();
}

/** Listen for one utterance. Resolves with the transcript, or rejects with ListenError. */
export async function listen(onInterim?: (text: string) => void, lang = "en-US"): Promise<string> {
  await loadServerStt();
  return listenNow(onInterim, lang);
}

function listenNow(onInterim: ((text: string) => void) | undefined, lang: string): Promise<string> {
  const engine = currentEngine();
  if (engine === "android" && nativeEars) {
    stopListening();
    consoleVoiceLog("start", { engine: "android" });
    return listenWithNative(nativeEars).then(
      (text) => (consoleVoiceLog("transcript", { text }), text),
      (error: ListenError) => {
        consoleVoiceLog("failed", { engine: "android", code: error.code });
        throw error;
      },
    );
  }
  if (engine === "server") {
    stopListening();
    consoleVoiceLog("start", { engine: "server", stt: serverStt });
    const handle = recordAnswer({}, { log: consoleVoiceLog });
    activeRecording = handle;
    const upload = new AbortController();
    const cancel = handle.cancel;
    handle.cancel = () => {
      upload.abort();
      cancel();
    };
    return handle.done
      .then((recording) => {
        onInterim?.("Transcribing…");
        return transcribeOnServer(recording.wav, fetch, upload.signal);
      })
      .then((text) => {
        if (!text) throw new ListenError("no-speech");
        consoleVoiceLog("transcript", { engine: "server", text });
        return text;
      })
      .catch((error: ListenError) => {
        consoleVoiceLog("failed", { engine: "server", code: error.code });
        throw error;
      })
      .finally(() => {
        if (activeRecording === handle) activeRecording = undefined;
      });
  }
  const Ctor = browserRecognition();
  if (!Ctor) return Promise.reject(new ListenError("unsupported"));
  stopListening();
  return recognizeOnce(Ctor, {
    lang,
    onInterim,
    log: consoleVoiceLog,
    onActive: (recognition) => (activeRecognition = recognition),
  }).catch((error: ListenError) => {
    if (error.code === "network") {
      browserServiceFailed = true;
      if (currentEngine() === "server") consoleVoiceLog("switching to server recognition");
    }
    throw error;
  });
}

/**
 * What this browser can do before anyone presses Speak: API, secure page, microphone
 * permission and device. Logged once so a failing setup can be diagnosed from the console.
 */
export async function checkVoice(): Promise<VoiceStatus & { env: VoiceEnvironment | null }> {
  if (nativeEars) return { available: true, message: "", engine: "android", env: null };
  await loadServerStt();
  const env: VoiceEnvironment = {
    hasRecognition: browserRecognition() !== undefined,
    isSecureContext: window.isSecureContext,
    micPermission: "unknown",
    audioInputs: null,
    brands: browserBrands(),
  };
  try {
    const state = (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
    env.micPermission = state;
  } catch {
    // Not every browser can query microphone permission.
  }
  try {
    // Counting devices needs no permission (labels stay hidden until it is granted).
    const devices = await navigator.mediaDevices?.enumerateDevices();
    if (devices) env.audioInputs = devices.filter((d) => d.kind === "audioinput").length;
  } catch {
    // Unknown.
  }
  const engine = currentEngine();
  // Recording for the server needs a microphone but not the browser's recognizer.
  const status = assessEnvironment(engine === "server" ? { ...env, hasRecognition: true } : env);
  if (status.available && !engine) {
    Object.assign(status, assessEnvironment({ ...env, hasRecognition: false }));
  }
  consoleVoiceLog("environment", { ...env, serverStt, engine, available: status.available, problem: status.problem });
  return { ...status, engine, env };
}
