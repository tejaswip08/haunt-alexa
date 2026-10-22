import { useEffect, useRef } from "react";
import { renderStage, sanitizePresentation, type MotionLevel, type Setting } from "@haunt/scene-fx";

/**
 * The animated scene backdrop: Haunt's hand-drawn illustration for the scene's setting
 * plus allowlisted effects (fog, flicker, shadows…), drawn by @haunt/scene-fx. The
 * illustrations are Haunt's own artwork, not AI-generated.
 */

export type SceneArtId = Setting;

export interface SceneImage {
  art?: SceneArtId;
  url?: string;
  alt: string;
  generated: boolean;
}

export function SceneArt(props: {
  image: SceneImage | null | undefined;
  /** Presentation metadata from the server. Validated again here; anything unknown is ignored. */
  presentation: unknown;
  mood: string;
  motion: MotionLevel;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { image, presentation, mood, motion } = props;
  useEffect(() => {
    if (!ref.current) return;
    const safe = sanitizePresentation(presentation, mood);
    // Older servers send only the illustration id; keep using it when there's no presentation.
    if (!presentation && image?.art) safe.setting = image.art;
    renderStage(ref.current, safe, { motion, alt: image?.alt ?? "", imageUrl: image?.url });
  }, [image, presentation, mood, motion]);
  return <div ref={ref} className={props.className} />;
}
