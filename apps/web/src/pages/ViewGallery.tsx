import type { CallToolResult } from "@modelcontextprotocol/client";
import { useEffect, useState } from "react";
import { SceneFrame } from "../components/SceneFrame.tsx";
import { device } from "../lib/device.ts";
import type { HauntConnection, ToolCall } from "../lib/mcp.ts";

/** Dev-only: the real scene view with sample data, in each theme and display mode. */

const scene = {
  kind: "scene",
  storyId: "st_sample",
  title: "The Forgotten Platform",
  sceneNumber: 3,
  totalScenes: 6,
  status: "active",
  mood: "suspense",
  narration:
    "The carriage door slides shut behind you with a sigh. Every seat is empty, yet each one holds a warm dent, as if its passenger stood up a moment ago. At the far end, the last compartment is locked from the outside. Something on the other side is scratching, slow and patient, at the height of a child's hand.",
  question: "Do you unlock the compartment, or pull the emergency brake?",
  suggestions: ["Unlock it", "Pull the brake", "Call out"],
  choicesSoFar: ["The listener boarded the train."],
  soundCues: ["scratching", "distant clock ticking"],
  visualPrompt: "",
};

const episode = {
  kind: "episode",
  storyId: "st_sample2",
  title: "The Lighthouse Keeper",
  creator: "Night Owl",
  summary: "A keeper finds the lamp already burning.",
  minutes: 4,
  language: "en",
  segments: [
    { narration: "The lamp was already burning when you reached the top of the stairs.", mood: "uneasy" },
    { narration: "Someone had polished the brass. Someone had wound the clock.", mood: "revelation" },
  ],
};

const SAMPLES: { label: string; data: object; theme: "light" | "dark"; mode: "inline" | "fullscreen"; width: number }[] = [
  { label: "Echo Show, dark (768×480 base canvas)", data: scene, theme: "dark", mode: "fullscreen", width: 768 },
  { label: "Echo Show, light", data: scene, theme: "light", mode: "fullscreen", width: 768 },
  { label: "Inline in a chat client, dark", data: scene, theme: "dark", mode: "inline", width: 560 },
  { label: "Library episode", data: episode, theme: "dark", mode: "fullscreen", width: 768 },
];

export function ViewGallery() {
  const [connection, setConnection] = useState<HauntConnection>();
  useEffect(() => {
    device.connect().then(setConnection, () => {});
  }, []);
  if (!connection) return <p className="page muted">Connecting…</p>;
  return (
    <div className="page view-gallery">
      <h1>View gallery</h1>
      {SAMPLES.map((sample) => {
        const real = connection.call("resume_story", { storyId: "st_none" });
        real.result.catch(() => {});
        const call: ToolCall = {
          ...real,
          input: {},
          result: Promise.resolve({ content: [], structuredContent: sample.data } as unknown as CallToolResult),
        };
        return (
          <figure key={sample.label} style={{ width: sample.width }}>
            <figcaption className="muted">{sample.label}</figcaption>
            <div className={sample.mode === "fullscreen" ? "gallery-screen" : undefined}>
              <SceneFrame
                call={call}
                connection={connection}
                onUserMessage={() => {}}
                theme={sample.theme}
                displayMode={sample.mode}
                devSameOrigin
              />
            </div>
          </figure>
        );
      })}
    </div>
  );
}
