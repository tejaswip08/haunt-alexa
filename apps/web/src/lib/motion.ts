import { useEffect, useState } from "react";
import {
  loadMotionPreference,
  probeSlowDevice,
  resolveMotion,
  saveMotionPreference,
  type MotionLevel,
  type MotionPreference,
} from "@haunt/scene-fx";

const reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
// One frame-rate check per page load, shared by every screen.
const slow = probeSlowDevice();

const ORDER: MotionPreference[] = ["auto", "full", "reduced", "off"];
export const MOTION_LABEL: Record<MotionPreference, string> = {
  auto: "Auto",
  full: "Full",
  reduced: "Reduced",
  off: "Off",
};

/** The viewer's animation setting and what actually plays. `?motion=off` in the URL overrides it. */
export function useMotion() {
  const forced = new URLSearchParams(window.location.search).get("motion") as MotionPreference | null;
  const [preference, setPreference] = useState<MotionPreference>(() =>
    forced && ORDER.includes(forced) ? forced : loadMotionPreference(),
  );
  const [reduced, setReduced] = useState(reducedQuery?.matches ?? false);
  const [slowDevice, setSlowDevice] = useState(false);

  useEffect(() => {
    void slow.then(setSlowDevice);
    const onChange = () => setReduced(reducedQuery?.matches ?? false);
    reducedQuery?.addEventListener("change", onChange);
    return () => reducedQuery?.removeEventListener("change", onChange);
  }, []);

  const level: MotionLevel = resolveMotion(preference, reduced, slowDevice);
  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]!;
    setPreference(next);
    saveMotionPreference(next);
  };
  return { preference, level, cycle, slowDevice };
}
