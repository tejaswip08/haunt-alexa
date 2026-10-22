import type { Tool } from "@modelcontextprotocol/client";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { useEffect, useState } from "react";
import { device } from "../lib/device.ts";
import { mcpEndpoint } from "../lib/mcp.ts";

export function Developers() {
  const [tools, setTools] = useState<Tool[]>();
  const [protocol, setProtocol] = useState<string>();
  const [error, setError] = useState<string>();
  const endpoint = mcpEndpoint();

  useEffect(() => {
    device.connect().then(
      (connection) => {
        setTools(connection.tools);
        setProtocol(connection.protocolVersion);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  const vscode = JSON.stringify(
    { servers: { haunt: { type: "http", url: endpoint, headers: { Authorization: "Bearer <your Haunt MCP token>" } } } },
    null,
    2,
  );

  return (
    <div className="page prose-page">
      <header className="page-head">
        <span className="eyebrow">For developers and judges</span>
        <h1>Connect to Haunt</h1>
        <p className="lede">
          Haunt is a self-hosted MCP server. The simulator on this site uses it, and so can any MCP client: Alexa+,
          Claude, ChatGPT, VS Code or your own agent. Turns render as an MCP App wherever MCP Apps are supported.
        </p>
      </header>

      <section className="card">
        <h2>Endpoint</h2>
        <CopyRow value={endpoint} />
        <p className="muted">
          Hosted servers require a bearer token (<code>Authorization: Bearer …</code>), issued by the Haunt team. A local
          development server accepts connections without one.
        </p>
        <dl className="facts">
          <div>
            <dt>Transport</dt>
            <dd>Streamable HTTP</dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>{protocol ?? "…"} (also negotiates 2025-06-18 and 2025-03-26)</dd>
          </div>
          <div>
            <dt>Auth</dt>
            <dd>None, open for testing</dd>
          </div>
          <div>
            <dt>UI</dt>
            <dd>MCP Apps scene view (ui://haunt/scene-…)</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <h2>Tools</h2>
        <p className="muted">Read live from this server’s tools/list.</p>
        {error && <p className="error">{error}</p>}
        {!tools && !error && <p className="muted">Loading…</p>}
        <div className="tool-list">
          {tools?.map((tool) => {
            const params = Object.entries(
              ((tool.inputSchema as { properties?: Record<string, { description?: string; type?: string; enum?: string[] }> })
                .properties ?? {}),
            );
            const required = new Set((tool.inputSchema as { required?: string[] }).required ?? []);
            return (
              <article key={tool.name} className="tool">
                <header>
                  <code className="tool-name">{tool.name}</code>
                  {getToolUiResourceUri(tool) && <span className="badge">MCP App</span>}
                  {tool.annotations?.readOnlyHint && <span className="badge quiet">read-only</span>}
                </header>
                <p>{tool.description}</p>
                {params.length > 0 && (
                  <ul className="params">
                    {params.map(([name, schema]) => (
                      <li key={name}>
                        <code>{name}</code>
                        {!required.has(name) && <span className="muted"> optional</span>}
                        {schema.enum && <span className="muted"> · {schema.enum.join(" | ")}</span>}
                        {schema.description && <span> · {schema.description}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2>Try it in your own client</h2>
        <h3>Claude</h3>
        <p>
          Settings → Connectors → Add custom connector, then paste the endpoint above. Ask for a scary story; turns
          render inline as an MCP App.
        </p>
        <h3>VS Code</h3>
        <pre className="code">{vscode}</pre>
        <h3>MCP Inspector</h3>
        <pre className="code">npx @modelcontextprotocol/inspector</pre>
        <p className="muted">Choose “Streamable HTTP” and paste the endpoint.</p>
      </section>

      <section className="card">
        <h2>Agent Skill</h2>
        <p>
          The Haunt skill teaches any agent how to host a story with these tools. The simulator’s assistant loads this
          exact file as its instructions.
        </p>
        <a className="button" href="/skills/haunt/SKILL.md" download>
          Download SKILL.md
        </a>
      </section>

      <section className="card">
        <h2>How it works</h2>
        <ol className="steps">
          <li>You speak. The simulated device transcribes you in the browser.</li>
          <li>
            The assistant (Claude on Amazon Bedrock, with the Haunt skill) decides which tool to call. The browser makes
            that call to the Haunt MCP server over Streamable HTTP.
          </li>
          <li>
            The FireTales engine writes the next turn with Claude on Amazon Bedrock, keeping every character, fact and
            choice consistent.
          </li>
          <li>The turn comes back as text plus an MCP App view. Amazon Polly narrates it, then the mic reopens.</li>
          <li>Finished stories export as narrator-only episodes: no questions, no listener voice.</li>
        </ol>
      </section>
    </div>
  );
}

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-row">
      <code>{value}</code>
      <button
        type="button"
        className="ghost small"
        onClick={() =>
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
