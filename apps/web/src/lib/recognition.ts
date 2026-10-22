/**
 * Browser speech recognition (Web Speech API), kept free of `window` so it can be tested
 * with a fake recognizer. speech.ts wires it to the real browser; the Fire TV app uses
 * Android's recognizer instead (see speech.ts).
 */

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart?: (() => void) | null;
  onaudiostart?: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}
export type RecognitionCtor = new () => SpeechRecognitionLike;

export class ListenError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(code === "no-speech" ? "I didn't hear anything." : `Listening failed: ${code}${detail ? ` (${detail})` : ""}`);
  }
}

/** Voice logs go to the console with a [voice] prefix. Transcripts are story answers, never secrets. */
export type VoiceLog = (event: string, detail?: Record<string, unknown>) => void;
export const consoleVoiceLog: VoiceLog = (event, detail) => console.info(`[voice] ${event}`, detail ?? "");

export interface RecognizeOptions {
  lang?: string;
  onInterim?: (text: string) => void;
  log?: VoiceLog;
  /** Called with the live recognizer so a caller can cancel it. */
  onActive?: (recognition: SpeechRecognitionLike | undefined) => void;
}

/** Listens for one utterance. Resolves with the final transcript, or rejects with a ListenError. */
export function recognizeOnce(Recognition: RecognitionCtor, options: RecognizeOptions = {}): Promise<string> {
  const { lang = "en-US", onInterim, log = () => {}, onActive } = options;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: ListenError | null, text?: string) => {
      if (settled) return;
      settled = true;
      onActive?.(undefined);
      if (error) {
        log("failed", { code: error.code });
        reject(error);
      } else {
        log("transcript", { text });
        resolve(text!);
      }
    };

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Recognition();
    } catch (error) {
      return finish(new ListenError("unsupported", (error as Error).name));
    }
    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    let finalText = "";
    recognition.onstart = () => log("start", { lang });
    recognition.onaudiostart = () => log("microphone open");
    recognition.onspeechstart = () => log("speech detected");
    recognition.onresult = (event) => {
      let interim = "";
      finalText = "";
      for (const result of Array.from(event.results)) {
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += transcript;
        else interim += transcript;
      }
      onInterim?.((finalText + interim).trim());
    };
    // Browsers fire `error` and then `end`; the first one decides the outcome.
    recognition.onerror = (event) => {
      log("error", { code: event.error, message: event.message || undefined });
      finish(new ListenError(event.error || "unknown", event.message));
    };
    recognition.onend = () => {
      log("end");
      if (finalText.trim()) finish(null, finalText.trim());
      else finish(new ListenError("no-speech"));
    };

    onActive?.(recognition);
    try {
      recognition.start();
    } catch (error) {
      // e.g. InvalidStateError when a recognizer is already running, or NotAllowedError.
      const name = (error as Error).name;
      log("start threw", { name });
      finish(new ListenError(name === "NotAllowedError" ? "not-allowed" : "start-failed", name));
    }
  });
}

// ---------- Why voice is (un)available ----------

export interface VoiceEnvironment {
  hasRecognition: boolean;
  isSecureContext: boolean;
  /** From navigator.permissions; "unknown" when the browser doesn't say. */
  micPermission: "granted" | "denied" | "prompt" | "unknown";
  /** Number of audio inputs, or null when the browser doesn't say. */
  audioInputs: number | null;
  /** Browser brands from navigator.userAgentData, when available. */
  brands: string[];
}

export type VoiceProblem =
  | "unsupported"
  | "insecure"
  | "permission-denied"
  | "no-microphone"
  | "service-unavailable"
  | "language"
  | "no-speech"
  | "cancelled"
  | "other";

export interface VoiceStatus {
  available: boolean;
  problem?: VoiceProblem;
  message: string;
  /** Which recognizer will listen: the browser's own, Android's, or Haunt's server (Amazon Transcribe). */
  engine?: VoiceEngine;
}

export type VoiceEngine = "browser" | "android" | "server";

/**
 * Picks the recognizer. Browsers with their own speech service (Chrome, Edge, Safari) keep
 * using it, which is free; the server is used only where the browser can't recognise speech.
 */
export function chooseEngine(options: {
  android: boolean;
  browserRecognition: boolean;
  browserHasService: boolean;
  /** The browser's recognizer already failed with "network" in this session. */
  browserFailed: boolean;
  serverAvailable: boolean;
  canRecord: boolean;
}): VoiceEngine | undefined {
  if (options.android) return "android";
  const browserUsable = options.browserRecognition && options.browserHasService && !options.browserFailed;
  if (browserUsable) return "browser";
  if (options.serverAvailable && options.canRecord) return "server";
  // Last resort: try the browser's recognizer even if it may fail; its error explains why.
  return options.browserRecognition && !options.browserFailed ? "browser" : undefined;
}

/** Decides before listening whether voice can work here, and if not, why. */
export function assessEnvironment(env: VoiceEnvironment): VoiceStatus {
  if (!env.hasRecognition) {
    return { available: false, problem: "unsupported", message: "This browser has no speech recognition. Use Google Chrome, Edge or Safari." };
  }
  if (!env.isSecureContext) {
    return { available: false, problem: "insecure", message: "Voice input needs a secure page: open Haunt at localhost or over HTTPS." };
  }
  if (env.micPermission === "denied") {
    return {
      available: false,
      problem: "permission-denied",
      message: "Microphone access is blocked for this site. Allow it from the icon in the address bar, then reload.",
    };
  }
  if (env.audioInputs === 0) {
    return { available: false, problem: "no-microphone", message: "No microphone found. Connect one, or use the remote." };
  }
  return { available: true, message: "" };
}

/** Chromium builds other than Google Chrome and Edge have the API but no speech service behind it. */
export function lacksSpeechService(brands: string[]): boolean {
  if (brands.length === 0) return false;
  return !brands.some((brand) => /Google Chrome|Microsoft Edge/i.test(brand));
}

/** Turns a recognition error code into a reason the listener can act on. */
export function describeListenFailure(code: string, env?: Partial<VoiceEnvironment>): VoiceStatus {
  const fallback = "Pick an answer with the remote instead.";
  switch (code) {
    case "aborted":
      return { available: true, problem: "cancelled", message: "" };
    case "no-speech":
    case "no-match":
      return { available: true, problem: "no-speech", message: "I didn't catch that. Try again, or pick an answer with the remote." };
    case "not-allowed":
    case "service-not-allowed":
    case "permission":
      if (env?.micPermission === "granted") {
        return {
          available: false,
          problem: "service-unavailable",
          message: `The browser blocked its speech service even though the microphone is allowed. ${fallback}`,
        };
      }
      return {
        available: false,
        problem: "permission-denied",
        message: "Microphone access is blocked. Allow it for this site (address bar icon, and System Settings › Privacy › Microphone on a Mac), then try again.",
      };
    case "audio-capture":
      return {
        available: false,
        problem: "no-microphone",
        message: "The microphone couldn't be opened. Check it's connected and not blocked in your system settings.",
      };
    case "network":
      return {
        available: false,
        problem: "service-unavailable",
        message: lacksSpeechService(env?.brands ?? [])
          ? "This browser can't reach a speech recognition service (only Google Chrome, Edge and Safari include one). Use the remote, or open Haunt in Google Chrome."
          : "The speech recognition service couldn't be reached. Check your internet connection, or use the remote.",
      };
    case "language-not-supported":
      return { available: false, problem: "language", message: `English speech recognition isn't available in this browser. ${fallback}` };
    case "rate-limited":
      return { available: true, problem: "other", message: "That was a lot of voice answers in a row. Wait a minute, or pick an answer with the remote." };
    case "too-long":
      return { available: true, problem: "other", message: "That answer was too long. Keep it under 12 seconds and try again." };
    case "bad-audio":
      return { available: true, problem: "other", message: `The recording couldn't be read. Try again, or ${fallback.toLowerCase()}` };
    case "server-off":
      return { available: false, problem: "service-unavailable", message: `Server speech recognition is switched off. ${fallback}` };
    case "server-unreachable":
    case "server-error":
      return { available: true, problem: "service-unavailable", message: `Haunt's speech service didn't answer. Try again, or ${fallback.toLowerCase()}` };
    case "insecure":
      return assessEnvironment({ hasRecognition: true, isSecureContext: false, micPermission: "unknown", audioInputs: null, brands: [] });
    case "unsupported":
      return assessEnvironment({ hasRecognition: false, isSecureContext: true, micPermission: "unknown", audioInputs: null, brands: [] });
    default:
      return { available: true, problem: "other", message: `Voice input failed (${code || "unknown error"}). ${fallback}` };
  }
}
