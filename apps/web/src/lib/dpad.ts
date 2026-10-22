/**
 * Spatial navigation for the TV remote. Arrow keys move focus to the nearest
 * `[data-focusable]` element in that direction; Enter/Select clicks it (the browser
 * already does that for buttons).
 */

export type Direction = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

const DIRECTIONS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function focusables(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-focusable]")).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
  );
}

/** Focus the element marked `data-autofocus`, or the first focusable one. */
export function focusFirst() {
  const items = focusables();
  (items.find((el) => el.hasAttribute("data-autofocus")) ?? items[0])?.focus();
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Picks the element the remote should move to. Candidates in the same row (for Left/Right)
 * or column (for Up/Down), meaning their band overlaps the current element's, win over
 * anything else; within a group, the nearest along the direction wins. Without this, a
 * button just below and to the right can beat the next card in the same row.
 */
export function pickNext(from: Box, candidates: readonly Box[], direction: Direction): number {
  const horizontal = direction === "ArrowLeft" || direction === "ArrowRight";
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best = -1;
  let bestKey: [number, number] = [Infinity, Infinity];
  candidates.forEach((r, index) => {
    const dx = r.left + r.width / 2 - fx;
    const dy = r.top + r.height / 2 - fy;
    const along = { ArrowUp: -dy, ArrowDown: dy, ArrowLeft: -dx, ArrowRight: dx }[direction];
    if (along <= 1) return;
    const overlap = horizontal
      ? Math.min(from.top + from.height, r.top + r.height) - Math.max(from.top, r.top)
      : Math.min(from.left + from.width, r.left + r.width) - Math.max(from.left, r.left);
    const across = horizontal ? Math.abs(dy) : Math.abs(dx);
    // [0 = same row/column, 1 = elsewhere], then distance.
    const key: [number, number] = overlap > 0 ? [0, along + across] : [1, along + across * 2];
    if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      bestKey = key;
      best = index;
    }
  });
  return best;
}

export function moveFocus(direction: Direction): boolean {
  const items = focusables();
  const current = document.activeElement as HTMLElement | null;
  if (!current || !items.includes(current)) {
    focusFirst();
    return true;
  }
  const others = items.filter((el) => el !== current);
  const index = pickNext(current.getBoundingClientRect(), others.map((el) => el.getBoundingClientRect()), direction);
  const best = index >= 0 ? others[index] : undefined;
  if (best) {
    best.focus({ preventScroll: true });
    revealInRow(best);
  }
  return best !== undefined;
}

/**
 * If `el` sits in a sideways-scrolling row (like the TV library), scroll only that row so the
 * whole card is visible. The rest of the TV layout is fixed and must never move.
 */
export function revealInRow(el: HTMLElement, margin = 24) {
  let row = el.parentElement;
  while (row && !(row.scrollWidth > row.clientWidth && /auto|scroll/.test(getComputedStyle(row).overflowX))) {
    row = row.parentElement;
  }
  if (!row) return;
  const box = el.getBoundingClientRect();
  const view = row.getBoundingClientRect();
  if (box.left < view.left + margin) row.scrollLeft -= view.left + margin - box.left;
  else if (box.right > view.right - margin) row.scrollLeft += box.right - (view.right - margin);
}

/** Install remote handling. `onBack` returns true when it handled the Back key. */
export function installDpad(handlers: { onBack?: () => boolean; onPlayPause?: (key: string) => void }) {
  const onKey = (event: KeyboardEvent) => {
    // Keys typed into a field belong to the field.
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    if (DIRECTIONS.has(event.key)) {
      event.preventDefault();
      moveFocus(event.key as Direction);
    } else if (event.key === "Escape" || event.key === "Backspace" || event.key === "GoBack") {
      if (handlers.onBack?.()) event.preventDefault();
    } else if (event.key === "MediaPlayPause" || event.key === "MediaPlay" || event.key === "MediaPause") {
      event.preventDefault();
      handlers.onPlayPause?.(event.key);
    }
  };
  window.addEventListener("keydown", onKey);
  // The Fire TV shell forwards the remote's Back button here and finishes the app when it returns false.
  const native = window as unknown as { hauntBack?: () => boolean };
  native.hauntBack = () => handlers.onBack?.() ?? false;
  return () => {
    window.removeEventListener("keydown", onKey);
    delete native.hauntBack;
  };
}
