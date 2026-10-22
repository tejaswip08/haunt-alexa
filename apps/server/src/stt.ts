import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
} from "@aws-sdk/client-transcribe-streaming";

/**
 * Speech to text for recorded answers. The audio is held in memory for one request and
 * streamed to Amazon Transcribe; nothing is written to disk or S3.
 */
export interface SpeechToText {
  readonly name: string;
  transcribe(audio: { pcm: Uint8Array; sampleRate: number }, options: { languageCode: string; signal: AbortSignal }): Promise<string>;
}

/** Offline stand-in: returns a fixed sentence (or "" for very short clips, to mimic silence). */
export function createMockSpeechToText(reply = "I open the door"): SpeechToText {
  return {
    name: "mock",
    async transcribe({ pcm, sampleRate }) {
      const seconds = pcm.byteLength / (sampleRate * 2);
      return seconds < 0.5 ? "" : reply;
    },
  };
}

/** 100 ms of 16-bit audio per event, as Transcribe's streaming guide suggests. */
const chunkBytes = (sampleRate: number) => Math.round(sampleRate * 0.1) * 2;

export function createTranscribeSpeechToText(options: { region: string; client?: Pick<TranscribeStreamingClient, "send"> }): SpeechToText {
  const client = options.client ?? new TranscribeStreamingClient({ region: options.region });
  return {
    name: "transcribe",
    async transcribe({ pcm, sampleRate }, { languageCode, signal }) {
      const size = chunkBytes(sampleRate);
      async function* stream(): AsyncIterable<AudioStream> {
        for (let at = 0; at < pcm.byteLength; at += size) {
          yield { AudioEvent: { AudioChunk: pcm.subarray(at, at + size) } };
        }
      }
      const response = await client.send(
        new StartStreamTranscriptionCommand({
          LanguageCode: languageCode as never,
          MediaEncoding: "pcm",
          MediaSampleRateHertz: sampleRate,
          AudioStream: stream(),
        }),
        { abortSignal: signal },
      );
      const parts: string[] = [];
      for await (const event of response.TranscriptResultStream ?? []) {
        for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
          if (result.IsPartial) continue;
          const text = result.Alternatives?.[0]?.Transcript?.trim();
          if (text) parts.push(text);
        }
      }
      return parts.join(" ").trim();
    },
  };
}
