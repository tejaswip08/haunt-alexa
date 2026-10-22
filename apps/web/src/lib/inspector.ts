import { useSyncExternalStore } from "react";

/** Everything the inspector panel shows: real MCP traffic, assistant turns, and speech. */
export type InspectorEvent =
  | { id: number; at: number; kind: "mcp"; direction: "out" | "in"; label: string; payload: unknown }
  | { id: number; at: number; kind: "agent"; direction: "out" | "in"; label: string; payload: unknown }
  | { id: number; at: number; kind: "speech"; who: "listener" | "device"; label: string }
  | { id: number; at: number; kind: "error"; label: string; payload?: unknown };

type NewEvent = InspectorEvent extends infer E ? (E extends InspectorEvent ? Omit<E, "id" | "at"> : never) : never;

const MAX_EVENTS = 400;
let events: InspectorEvent[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

export function record(event: NewEvent) {
  events = [...events.slice(-(MAX_EVENTS - 1)), { ...event, id: nextId++, at: Date.now() } as InspectorEvent];
  for (const listener of listeners) listener();
}

export function clearEvents() {
  events = [];
  for (const listener of listeners) listener();
}

export function useInspectorEvents(): InspectorEvent[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => events,
  );
}
