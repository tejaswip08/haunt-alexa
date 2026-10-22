/**
 * Strict WAV (RIFF) parsing for spoken answers. The header is read from the bytes
 * themselves, so a client can't claim a format or duration it didn't send.
 */

export interface PcmAudio {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Raw little-endian samples, header removed. */
  pcm: Uint8Array;
  durationSeconds: number;
}

export class AudioFormatError extends Error {
  constructor(
    readonly code: "not-wav" | "unsupported-encoding" | "truncated" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "AudioFormatError";
  }
}

/** What Transcribe streaming accepts as PCM: signed 16-bit little-endian, 8–48 kHz, mono. */
const ALLOWED_RATES = new Set([8000, 16000, 22050, 24000, 32000, 44100, 48000]);

export function parseWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new AudioFormatError("not-wav", "The recording isn't a WAV file.");
  }

  let offset = 12;
  let format: { encoding: number; channels: number; sampleRate: number; bits: number } | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) throw new AudioFormatError("truncated", "The WAV header is incomplete.");
      format = {
        encoding: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new AudioFormatError("not-wav", "The WAV file has no format section.");
      if (format.encoding !== 1 || format.bits !== 16 || format.channels !== 1 || !ALLOWED_RATES.has(format.sampleRate)) {
        throw new AudioFormatError(
          "unsupported-encoding",
          "Recordings must be mono 16-bit PCM at a standard sample rate (8–48 kHz).",
        );
      }
      const end = Math.min(body + size, bytes.byteLength);
      if (end - body < size && size !== 0xffffffff) throw new AudioFormatError("truncated", "The recording was cut off.");
      const pcm = bytes.subarray(body, end - ((end - body) % 2));
      if (pcm.byteLength === 0) throw new AudioFormatError("empty", "The recording is empty.");
      return {
        sampleRate: format.sampleRate,
        channels: 1,
        bitsPerSample: 16,
        pcm,
        durationSeconds: pcm.byteLength / (format.sampleRate * 2),
      };
    }
    offset = body + size + (size % 2);
  }
  throw new AudioFormatError("truncated", "The WAV file has no audio data.");
}
