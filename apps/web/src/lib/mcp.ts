import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client";
import { getToolUiResourceUri, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import { randomId } from "./id.ts";
import { session } from "./session.ts";
import { record } from "./inspector.ts";

export const HOST_INFO = { name: "haunt-alexa-simulator", version: "0.1.0" };

/** Haunt's own pages use a same-origin MCP route; external clients use /mcp with a bearer token. */
const APP_MCP_PATH = "/api/mcp";

/** The public MCP endpoint for external clients (shown on the Developers page). */
export function mcpEndpoint(): string {
  return new URL("/mcp", window.location.origin).href;
}

/** Wraps a transport so every JSON-RPC message, in both directions, shows up in the inspector. */
class InspectedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  constructor(private readonly inner: Transport) {
    inner.onmessage = (message, extra) => {
      record({ kind: "mcp", direction: "in", label: describe(message), payload: message });
      this.onmessage?.(message, extra);
    };
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
  }

  get sessionId() {
    return this.inner.sessionId;
  }

  setProtocolVersion = (version: string) => this.inner.setProtocolVersion?.(version);

  start() {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions) {
    record({ kind: "mcp", direction: "out", label: describe(message), payload: message });
    return this.inner.send(message, options);
  }

  close() {
    return this.inner.close();
  }
}

const pendingMethods = new Map<string | number, string>();

function describe(message: JSONRPCMessage): string {
  if ("method" in message) {
    if ("id" in message && message.id !== undefined) pendingMethods.set(message.id, message.method);
    const params = (message as { params?: { name?: string; uri?: string } }).params;
    const detail = params?.name ?? params?.uri;
    return detail ? `${message.method} · ${detail}` : message.method;
  }
  if ("id" in message && message.id !== undefined) {
    const method = pendingMethods.get(message.id) ?? "response";
    pendingMethods.delete(message.id);
    if ("error" in message) return `${method} ✕ error`;
    const delivery = (message as { result?: { _meta?: Record<string, { source?: string; ms?: number }> } }).result?._meta?.[
      "io.haunt/delivery"
    ];
    if (delivery?.source === "prewritten") return `${method} ✓ · pre-written branch, ${delivery.ms} ms`;
    if (delivery) return `${method} ✓ · written ${delivery.source === "opening" ? "fresh" : "live"}, ${delivery.ms} ms`;
    return `${method} ✓`;
  }
  return "message";
}

export interface ToolCall {
  id: string;
  tool: Tool;
  input: Record<string, unknown>;
  result: Promise<CallToolResult>;
  /** Present when the tool declares an MCP App view. */
  viewHtml?: Promise<string>;
}

export interface HauntConnection {
  client: Client;
  tools: Tool[];
  protocolVersion: string | undefined;
  call(name: string, input: Record<string, unknown>): ToolCall;
}

let connecting: Promise<HauntConnection> | undefined;

/** One shared connection to the Haunt MCP server, over Streamable HTTP. */
export function connectHaunt(): Promise<HauntConnection> {
  connecting ??= open().catch((error) => {
    connecting = undefined;
    throw error;
  });
  return connecting;
}

async function open(): Promise<HauntConnection> {
  const client = new Client(HOST_INFO);
  await client.connect(
    new InspectedTransport(
      new StreamableHTTPClientTransport(new URL(APP_MCP_PATH, window.location.origin), {
        requestInit: { headers: { "X-Haunt-Client": "web" } },
        // Every request carries the current sign-in (renewed as needed): signed-in listeners own
        // the stories they start, and only they can continue them.
        fetch: session.fetch,
      }),
    ),
  );
  const { tools } = await client.listTools();
  const views = new Map<string, Promise<string>>();

  const readView = (uri: string) => {
    let html = views.get(uri);
    if (!html) {
      html = client.readResource({ uri }).then(({ contents }) => {
        const content = contents[0];
        if (!content || content.mimeType !== RESOURCE_MIME_TYPE) throw new Error(`${uri} is not an MCP App view`);
        return "text" in content ? content.text : atob(content.blob);
      });
      html.catch(() => views.delete(uri));
      views.set(uri, html);
    }
    return html;
  };

  return {
    client,
    tools,
    protocolVersion: client.getNegotiatedProtocolVersion?.(),
    call(name, input) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      const uri = getToolUiResourceUri(tool);
      return {
        id: randomId(),
        tool,
        input,
        result: client.callTool({ name, arguments: input }) as Promise<CallToolResult>,
        viewHtml: uri ? readView(uri) : undefined,
      };
    },
  };
}
