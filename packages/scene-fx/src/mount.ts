import { sceneArtSvg } from "./art.ts";
import type { MotionLevel, Presentation } from "./effects.ts";

export interface StageOptions {
  motion: MotionLevel;
  /** Text alternative for the illustration. */
  alt: string;
  /** An image file to show instead of the illustration (for example a generated image). */
  imageUrl?: string;
}

const PARTICLES = 14;

/**
 * Draws a scene's animated backdrop into `container`, replacing what was there.
 * Every layer is decorative and sits behind the story text; pointer events and focus
 * are disabled so the remote and touch input never land on it.
 */
export function renderStage(container: HTMLElement, presentation: Presentation, options: StageOptions) {
  const stage = document.createElement("div");
  stage.className = "fx-stage";
  stage.dataset.setting = presentation.setting;
  stage.dataset.intensity = presentation.intensity;
  stage.dataset.motion = options.motion;
  for (const effect of presentation.effects) stage.classList.add(`fx-${effect.replace(/_/g, "-")}`);

  const camera = document.createElement("div");
  camera.className = "fx-camera";
  if (options.imageUrl) {
    const img = document.createElement("img");
    img.className = "fx-art";
    img.src = options.imageUrl;
    img.alt = options.alt;
    camera.append(img);
  } else {
    camera.innerHTML = sceneArtSvg(presentation.setting, options.alt);
  }
  stage.append(camera);

  if (options.motion !== "off") {
    const has = (effect: string) => presentation.effects.includes(effect as never);
    if (has("ambient_fog")) stage.append(layer("fx-fog fx-fog-a"), layer("fx-fog fx-fog-b"));
    if (has("flickering_light")) stage.append(layer("fx-flicker-veil"));
    if (has("door_opens")) stage.append(layer("fx-door-light"));
    if (has("shadow_appears")) stage.append(layer("fx-passing-shadow"));
    if (options.motion === "full" && presentation.intensity !== "low") {
      const dust = layer("fx-particles");
      for (let i = 0; i < PARTICLES; i++) {
        const mote = document.createElement("i");
        // Spread motes evenly with a little variation; no randomness, so renders are stable.
        mote.style.left = `${(i * 71) % 100}%`;
        mote.style.animationDelay = `${-(i * 1.7) % 14}s`;
        mote.style.animationDuration = `${12 + (i % 5) * 2}s`;
        dust.append(mote);
      }
      stage.append(dust);
    }
  }
  stage.append(layer("fx-vignette"));

  container.replaceChildren(stage);
  return stage;
}

function layer(className: string) {
  const el = document.createElement("div");
  el.className = className;
  el.setAttribute("aria-hidden", "true");
  return el;
}
