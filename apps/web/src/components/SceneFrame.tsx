import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { useEffect, useRef, useState } from "react";
import { record } from "../lib/inspector.ts";
import { HOST_INFO, type HauntConnection, type ToolCall } from "../lib/mcp.ts";

interface Props {
  call: ToolCall;
  connection: HauntConnection;
  /** The view asked the host to send a message as the user (e.g. a tapped suggestion). */
  onUserMessage: (text: string) => void;
  /** The view finished its handshake and has its tool input. */
  onReady?: () => void;
  theme: "light" | "dark";
  /** Fullscreen fills the device screen; inline sizes to the view's content. */
  displayMode?: "inline" | "fullscreen";
  /** Dev gallery only: same-origin frames can be captured in screenshots. Never for real use. */
  devSameOrigin?: boolean;
}

/**
 * Renders one tool call's MCP App view in a sandboxed iframe and connects it to the
 * MCP server through the official AppBridge. The iframe has an opaque origin
 * (no allow-same-origin), so it is isolated from the simulator page.
 */
export function SceneFrame({
  call,
  connection,
  onUserMessage,
  onReady,
  theme,
  displayMode = "fullscreen",
  devSameOrigin = false,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [ready, setReady] = useState(false);
  const onUserMessageRef = useRef(onUserMessage);
  onUserMessageRef.current = onUserMessage;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow || !call.viewHtml) return;
    let disposed = false;

    const capabilities = connection.client.getServerCapabilities();
    const bridge = new AppBridge(
      connection.client,
      HOST_INFO,
      { openLinks: {}, serverTools: capabilities?.tools, serverResources: capabilities?.resources },
      {
        hostContext: {
          theme: themeRef.current,
          platform: "web",
          displayMode,
          availableDisplayModes: displayMode === "inline" ? ["inline", "fullscreen"] : ["fullscreen"],
          containerDimensions: { width: iframe.clientWidth, height: iframe.clientHeight },
        },
      },
    );

    bridge.onmessage = async (params) => {
      const text = params.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(" ")
        .trim();
      record({ kind: "mcp", direction: "in", label: "ui/message (from view)", payload: params });
      if (text) onUserMessageRef.current(text);
      return {};
    };
    bridge.onopenlink = async ({ url }) => {
      window.open(url, "_blank", "noopener,noreferrer");
      return {};
    };
    bridge.onsizechange = async ({ height }) => {
      // The device screen has a fixed size; inline views grow to fit their content.
      if (displayMode === "inline" && height) iframe.style.height = `${height}px`;
    };
    bridge.onrequestdisplaymode = async () => ({ mode: "fullscreen" });

    bridgeRef.current = bridge;
    const initialized = new Promise<void>((resolve) => {
      bridge.oninitialized = () => resolve();
    });

    (async () => {
      await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
      const html = await call.viewHtml!;
      if (disposed) return;
      iframe.srcdoc = html;
      await initialized;
      if (disposed) return;
      setReady(true);
      onReadyRef.current?.();
      bridge.sendToolInput({ arguments: call.input });
      call.result.then(
        (result) => {
          if (!disposed) void bridge.sendToolResult(result);
        },
        (error: Error) => {
          if (!disposed) void bridge.sendToolCancelled({ reason: error.message });
        },
      );
    })().catch((error) => record({ kind: "error", label: `View failed: ${(error as Error).message}`, payload: error }));

    return () => {
      disposed = true;
      bridgeRef.current = null;
      bridge.close().catch(() => {});
    };
  }, [call, connection, displayMode]);

  // The device's screen setting changed: tell the view, as Alexa+ would.
  useEffect(() => {
    if (ready) void bridgeRef.current?.sendHostContextChange({ theme });
  }, [theme, ready]);

  return (
    <iframe
      ref={iframeRef}
      className={`scene-frame${ready ? " is-ready" : ""}${displayMode === "inline" ? " is-inline" : ""}`}
      title={call.tool.title ?? call.tool.name}
      sandbox={devSameOrigin ? "allow-scripts allow-same-origin" : "allow-scripts"}
    />
  );
}
