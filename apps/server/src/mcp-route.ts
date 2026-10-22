import { createHash } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { McpServer } from "@modelcontextprotocol/server";
import { type Request, type Response, Router } from "express";
import { identify, userOf, type Authenticator, type User } from "./auth.ts";
import { ensureGuestKey, guestKeyHash } from "./guest.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { hasBearerToken, isFirstParty, maxBody, rateLimit } from "./request-guards.ts";

export type McpAccess =
  /** /mcp for any MCP client (Claude, VS Code, Alexa+ once registered): bearer token, open CORS. */
  | { kind: "external"; tokens: string[]; production: boolean }
  /** /api/mcp for Haunt's own /play and /tv pages: same origin only. */
  | { kind: "first-party"; extraOrigins?: string[] };

export interface McpRouteOptions {
  access: McpAccess;
  /** Gets the signed-in listener on first-party routes; external clients are never a user. */
  createServer: (user?: User, guestKeyHash?: string) => Promise<McpServer>;
  /** First-party only: who is signed in. Without it, every caller is anonymous. */
  authenticate?: Authenticator;
  /** First-party only: give guests a guest-key cookie (see guest.ts). `secure` for HTTPS-only cookies. */
  guests?: { secure: boolean };
  limiter: RateLimiter;
  maxBytes?: number;
  /**
   * Decides whether a tool call may run, checked before any story is touched. `external` is true on /mcp,
   * where callers are token holders with no user. Without this option, every tool call is allowed (development only).
   */
  authorizeTool?: (user: User | undefined, toolName: string, external: boolean) => Promise<boolean>;
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

/** Tools that create or change a story. Read-only tools (list_library, play_episode) are never gated here. */
export const STORY_WRITE_TOOLS = new Set(["start_story", "answer_story", "end_story", "resume_story"]);

/** The tool names in a JSON-RPC body, single or batched, that are calls to write tools. */
function writeToolCalls(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .filter((m): m is { method: string; params?: { name?: unknown } } => Boolean(m) && typeof m === "object" && (m as { method?: unknown }).method === "tools/call")
    .map((m) => String(m.params?.name ?? ""))
    .filter((name) => STORY_WRITE_TOOLS.has(name));
}

/**
 * MCP over Streamable HTTP, stateless: story state lives in the story store, not the MCP
 * session, so every request gets a fresh server and independent clients never share state.
 */
/** Owner key for stories an external client starts: a hash of its bearer token, so the raw token is never stored. */
function tokenOwnerHash(req: Request): string | undefined {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return undefined;
  return createHash("sha256").update(`mcp-token:${header.slice(7)}`).digest("hex");
}

export function createMcpRouter(options: McpRouteOptions): Router {
  const { access, createServer, authenticate, guests, limiter, maxBytes = 256 * 1024 } = options;
  const router = Router();

  if (access.kind === "external") {
    router.use((req, res, next) => {
      // Any origin may call with a token; tokens travel in a header, never in cookies.
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
      if (req.method === "OPTIONS") return void res.sendStatus(204);
      next();
    });
  }

  router.use((req, res, next) => {
    if (access.kind === "first-party") {
      if (!isFirstParty(req, { name: "x-haunt-client", value: "web" }, access.extraOrigins)) {
        return void res.status(403).json(rpcError(-32001, "This endpoint is for Haunt's own pages. External clients use /mcp."));
      }
      return next();
    }
    if (access.tokens.length === 0) {
      // Development only: no tokens configured and not in production means a local, open endpoint.
      if (!access.production) return next();
      res.setHeader("WWW-Authenticate", 'Bearer realm="haunt-mcp"');
      return void res.status(401).json(rpcError(-32001, "MCP access isn't configured on this server."));
    }
    if (!hasBearerToken(req, access.tokens)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="haunt-mcp"');
      return void res.status(401).json(rpcError(-32001, "Missing or invalid bearer token."));
    }
    next();
  });

  if (access.kind === "first-party" && authenticate) router.use(identify(authenticate));

  router.use(maxBody(maxBytes, () => rpcError(-32600, "Request too large.")));
  router.use(rateLimit(limiter, (retry) => rpcError(-32000, `Too many requests. Try again in ${retry} s.`)));

  router.all("/", async (req: Request, res: Response) => {
    const user = access.kind === "first-party" ? userOf(res) : undefined;
    // Authorization happens here, on the server, before the request reaches any story code.
    if (req.method === "POST" && options.authorizeTool) {
      const denied = new Set<string>();
      for (const tool of writeToolCalls(req.body)) {
        if (!(await options.authorizeTool(user, tool, access.kind === "external"))) denied.add(tool);
      }
      if (denied.size > 0) {
        return void res.status(403).json(rpcError(-32001, "Your account can't change stories. Creator access is needed."));
      }
    }
    // Signed-in users keep reaching the guest stories from this browser until they claim them.
    // External stories belong to the bearer token that started them (hashed, never stored raw), so that client can continue them.
    const guest =
      access.kind === "external" ? tokenOwnerHash(req)
      : !guests ? undefined : user ? guestKeyHash(req) : ensureGuestKey(req, res, guests.secure);
    const server = await createServer(user, guest);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      // Log the kind of failure only; request bodies can contain story text.
      console.error("[mcp] request failed:", (error as Error).name, (error as Error).message?.slice(0, 200));
      if (!res.headersSent) res.status(500).json(rpcError(-32603, "Internal server error"));
    }
  });
  return router;
}
