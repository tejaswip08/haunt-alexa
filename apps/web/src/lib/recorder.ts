import { ListenError, type VoiceLog } from "./recognition.ts";
import { downsample, encodeWav, floatTo16, rms, TARGET_RATE } from "./pcm.ts";

/**
 * Records one spoken answer with getUserMedia + Web Audio and returns it as 16 kHz mono
 * 16-bit WAV, the format Amazon Transcribe streaming accepts. (MediaRecorder isn't used:
 * Chromium browsers can only produce WebM/Opus with it, which streaming doesn't accept.)
 * The audio stays in memory and is dropped as soon as it has been uploaded.
 */

export interface RecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createContext?: () => AudioContextLike;
}

/** The parts of AudioContext the recorder uses, so tests can supply a fake. */
export interface AudioContextLike {
  sampleRate: number;
  createMediaStreamSource(stream: MediaStream): { connect(node: unknown): void; disconnect(): void };
  createScriptProcessor(size: number, inputs: number, outputs: number): {
    onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
    connect(node: unknown): void;
    disconnect(): void;
  };
  destination: unknown;
  close(): Promise<void>;
}

export interface Recording {
  wav: Uint8Array;
  seconds: number;
  /** True if the input ever rose above the speech threshold. */
  heardSpeech: boolean;
}

export interface RecorderHandle {
  /** Resolves with the recording, or rejects with a ListenError ("aborted", "not-allowed"…). */
  done: Promise<Recording>;
  /** Stop and keep what was recorded. */
  finish(): void;
  /** Stop and throw the recording away. */
  cancel(): void;
}

export interface RecordOptions {
  maxSeconds?: number;
  /** Stop on its own after this much quiet following speech. */
  silenceSeconds?: number;
  /** Give up if nothing louder than room noise arrives within this long. */
  noSpeechSeconds?: number;
  speechThreshold?: number;
  onLevel?: (level: number) => void;
  log?: VoiceLog;
}

/** Whether this browser can record at all (secure page, getUserMedia, Web Audio). */
export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof (window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) === "function"
  );
}

export function recordAnswer(deps: RecorderDeps = {}, options: RecordOptions = {}): RecorderHandle {
  const {
    maxSeconds = 12,
    silenceSeconds = 1.3,
    noSpeechSeconds = 6,
    speechThreshold = 0.02,
    onLevel,
    log = () => {},
  } = options;
  const getUserMedia = deps.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
  const createContext =
    deps.createContext ??
    (() => {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      return new Ctor() as unknown as AudioContextLike;
    });

  let resolveDone!: (r: Recording) => void;
  let rejectDone!: (e: ListenError) => void;
  const done = new Promise<Recording>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  let state: "starting" | "recording" | "stopped" = "starting";
  let cancelled = false;
  let cleanup = () => {};
  const blocks: Float32Array[] = [];
  let rate = TARGET_RATE;
  let heardSpeech = false;
  let elapsed = 0;
  let quietFor = 0;

  const stop = (keep: boolean) => {
    if (state === "stopped") return;
    const wasRecording = state === "recording";
    state = "stopped";
    cleanup();
    if (!keep || !wasRecording) {
      log("recording cancelled");
      return rejectDone(new ListenError("aborted"));
    }
    const total = blocks.reduce((n, b) => n + b.length, 0);
    const joined = new Float32Array(total);
    let at = 0;
    for (const block of blocks) {
      joined.set(block, at);
      at += block.length;
    }
    const samples = floatTo16(downsample(joined, rate));
    const seconds = samples.length / TARGET_RATE;
    log("recording finished", { seconds: Math.round(seconds * 10) / 10, heardSpeech });
    if (!heardSpeech) return rejectDone(new ListenError("no-speech"));
    resolveDone({ wav: encodeWav(samples), seconds, heardSpeech });
  };

  (async () => {
    let stream: MediaStream;
    try {
      stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      const name = (error as Error).name;
      log("microphone refused", { name });
      state = "stopped";
      const code =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "not-allowed"
          : name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError"
            ? "audio-capture"
            : name === "SecurityError"
              ? "insecure"
              : "start-failed";
      return rejectDone(new ListenError(code, name));
    }
    if (cancelled) {
      stream.getTracks().forEach((t) => t.stop());
      state = "stopped";
      return rejectDone(new ListenError("aborted"));
    }
    let context: AudioContextLike;
    try {
      context = createContext();
    } catch (error) {
      stream.getTracks().forEach((t) => t.stop());
      state = "stopped";
      return rejectDone(new ListenError("unsupported", (error as Error).name));
    }
    rate = context.sampleRate;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (state !== "recording") return;
      const block = new Float32Array(event.inputBuffer.getChannelData(0));
      blocks.push(block);
      const seconds = block.length / rate;
      elapsed += seconds;
      const level = rms(block);
      onLevel?.(level);
      if (level > speechThreshold) {
        if (!heardSpeech) log("speech detected");
        heardSpeech = true;
        quietFor = 0;
      } else {
        quietFor += seconds;
      }
      if (elapsed >= maxSeconds) stop(true);
      else if (heardSpeech && quietFor >= silenceSeconds) stop(true);
      else if (!heardSpeech && elapsed >= noSpeechSeconds) stop(true);
    };
    source.connect(processor);
    processor.connect(context.destination);
    cleanup = () => {
      processor.onaudioprocess = null;
      try {
        source.disconnect();
        processor.disconnect();
      } catch {
        // Already disconnected.
      }
      stream.getTracks().forEach((t) => t.stop());
      void context.close().catch(() => {});
    };
    state = "recording";
    log("recording", { sampleRate: rate });
  })();

  return {
    done,
    finish: () => stop(true),
    cancel: () => {
      cancelled = true;
      stop(false);
    },
  };
}
