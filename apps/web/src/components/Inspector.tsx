import { useEffect, useMemo, useRef, useState } from "react";
import { clearEvents, useInspectorEvents, type InspectorEvent } from "../lib/inspector.ts";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "mcp", label: "MCP" },
  { id: "agent", label: "Assistant" },
  { id: "speech", label: "Speech" },
] as const;

type Filter = (typeof FILTERS)[number]["id"];

export function Inspector({ protocolVersion }: { protocolVersion?: string }) {
  const events = useInspectorEvents();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const visible = useMemo(
    () => events.filter((e) => filter === "all" || e.kind === filter || (filter === "mcp" && e.kind === "error")),
    [events, filter],
  );

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [visible.length]);

  const mcpCount = events.filter((e) => e.kind === "mcp").length;

  return (
    <section id="inspector" className="inspector" aria-label="MCP inspector">
      <header className="inspector-head">
        <div>
          <h2>Live MCP inspector</h2>
          <p className="muted">
            Streamable HTTP · protocol {protocolVersion ?? "…"} · {mcpCount} messages
          </p>
        </div>
        <button type="button" className="ghost small" onClick={clearEvents}>
          Clear
        </button>
      </header>
      <div className="chips" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`chip${filter === f.id ? " is-on" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ol className="events" ref={listRef}>
        {visible.length === 0 && <li className="empty muted">Say something to the device. Every MCP message appears here.</li>}
        {visible.map((event) => (
          <EventRow key={event.id} event={event} open={open === event.id} onToggle={() => setOpen(open === event.id ? null : event.id)} />
        ))}
      </ol>
    </section>
  );
}

function EventRow({ event, open, onToggle }: { event: InspectorEvent; open: boolean; onToggle: () => void }) {
  const time = new Date(event.at).toLocaleTimeString([], { hour12: false });
  const arrow =
    event.kind === "speech" ? (event.who === "listener" ? "🎙" : "🔊") : event.kind === "error" ? "!" : event.direction === "out" ? "→" : "←";
  const payload = "payload" in event ? event.payload : undefined;
  return (
    <li className={`event kind-${event.kind}`}>
      <button type="button" className="event-line" onClick={onToggle} disabled={payload === undefined} aria-expanded={open}>
        <span className="event-time">{time}</span>
        <span className="event-arrow" aria-hidden>
          {arrow}
        </span>
        <span className="event-label">{event.label}</span>
      </button>
      {open && payload !== undefined && <pre className="event-json">{JSON.stringify(payload, null, 2)}</pre>}
    </li>
  );
}
