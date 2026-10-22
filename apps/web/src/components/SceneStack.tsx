import { useEffect, useState } from "react";
import type { HauntConnection, ToolCall } from "../lib/mcp.ts";
import { SceneFrame } from "./SceneFrame.tsx";

/**
 * Keeps the previous scene on screen until the next view has loaded, then cross-fades.
 * Each tool call still gets its own view instance, as MCP Apps expects.
 */
export function SceneStack({
  call,
  connection,
  onUserMessage,
  theme,
}: {
  call: ToolCall;
  connection: HauntConnection;
  onUserMessage: (text: string) => void;
  theme: "light" | "dark";
}) {
  const [frames, setFrames] = useState<ToolCall[]>([call]);

  useEffect(() => {
    setFrames((current) => (current.at(-1)?.id === call.id ? current : [...current.slice(-1), call]));
  }, [call]);

  return (
    <>
      {frames.map((frame) => (
        <SceneFrame
          key={frame.id}
          call={frame}
          connection={connection}
          onUserMessage={onUserMessage}
          theme={theme}
          onReady={() => {
            // Let the fade-in finish before removing the scene underneath.
            setTimeout(() => setFrames((current) => current.filter((f) => f === frame || current.indexOf(f) > current.indexOf(frame))), 900);
          }}
        />
      ))}
    </>
  );
}
