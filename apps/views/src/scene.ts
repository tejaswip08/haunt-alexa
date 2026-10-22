import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { probeSlowDevice, renderStage, resolveMotion, sanitizePresentation } from "@haunt/scene-fx";
import "@haunt/scene-fx/fx.css";
import "./scene.css";

/** Mirrors SceneView in apps/server/src/mcp.ts. */
interface SceneView {
  kind: "scene";
  storyId: string;
  title: string;
  sceneNumber: number;
  totalScenes: number;
  status: "active" | "completed";
  mood: string;
  narration: string;
  question: string | null;
  suggestions: string[];
  soundCues: string[];
  visualPrompt?: string;
  /** Setting and allowlisted effects. Validated again before anything is drawn. */
  presentation?: unknown;
}

/** Mirrors EpisodeView in apps/server/src/mcp.ts. */
interface EpisodeView {
  kind: "episode";
  storyId: string;
  title: string;
  creator: string;
  minutes: number;
  segments: { narration: string; mood: string; visualPrompt?: string; presentation?: unknown }[];
}

/** Alexa+ lays add-on UI out on a 768×480 canvas and scales it to the device. */
const BASE = { width: 768, height: 480 };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = $("scene");
const title = $("title");
const progress = $("progress");
const narration = $("narration");
const sounds = $("sounds");
const ask = $("ask");
const question = $("question");
const suggestions = $("suggestions");
const status = $("status");
const expand = $<HTMLButtonElement>("expand");
const fx = $("fx");

// Animated backdrop. Hosts can't pass a viewer setting into the view, so follow the system's
// reduced-motion setting and step down on slow devices.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let slowDevice = false;
void probeSlowDevice().then((slow) => (slowDevice = slow));
function drawBackdrop(presentation: unknown, mood: string, alt: string) {
  renderStage(fx, sanitizePresentation(presentation, mood), {
    motion: resolveMotion("auto", reducedMotion.matches, slowDevice),
    alt,
  });
}

const app = new App({ name: "Haunt scene", version: "0.2.0" });

app.ontoolinput = () => {
  root.dataset.state = "waiting";
  status.textContent = "The story is gathering in the dark…";
};

app.ontoolresult = (result) => {
  const view = result.structuredContent as SceneView | EpisodeView | undefined;
  if (!result.isError && view?.kind === "scene") return render(view);
  if (!result.isError && view?.kind === "episode") return renderEpisode(view);
  const message = result.content?.find((c) => c.type === "text");
  showError(message && "text" in message ? message.text : "Something went wrong.");
};

app.ontoolcancelled = () => showError("The story was interrupted.");

app.onhostcontextchanged = () => adaptToHost();

expand.addEventListener("click", () => {
  void app.requestDisplayMode({ mode: "fullscreen" });
});

function render(view: SceneView) {
  root.dataset.state = "ready";
  root.dataset.mood = view.mood;
  drawBackdrop(view.presentation, view.mood, view.visualPrompt ?? "");
  title.textContent = view.title;
  progress.textContent = "";
  progress.replaceChildren(
    ...Array.from({ length: view.totalScenes }, (_, i) => {
      const dot = document.createElement("i");
      if (i < view.sceneNumber) dot.className = "done";
      return dot;
    }),
  );
  progress.setAttribute("aria-label", `Turn ${view.sceneNumber} of ${view.totalScenes}`);
  setParagraphs(view.narration.split(/\n{2,}/));
  sounds.textContent = view.soundCues.length ? `[${view.soundCues.join(" · ")}]` : "";

  const ended = view.status === "completed";
  root.dataset.ended = String(ended);
  ask.hidden = false;
  question.textContent = ended ? "The End." : (view.question ?? "");
  const choices = ended ? ["Tell me another story"] : view.suggestions;
  suggestions.replaceChildren(...choices.map(choiceButton));
  status.textContent = "";
}

function renderEpisode(view: EpisodeView) {
  root.dataset.state = "ready";
  root.dataset.mood = view.segments[0]?.mood ?? "uneasy";
  drawBackdrop(view.segments[0]?.presentation, root.dataset.mood, view.segments[0]?.visualPrompt ?? "");
  title.textContent = view.title;
  progress.removeAttribute("aria-label");
  progress.replaceChildren();
  progress.textContent = `${view.minutes} min · by ${view.creator}`;
  setParagraphs(view.segments.map((segment) => segment.narration));
  sounds.textContent = "";
  root.dataset.ended = "true";
  ask.hidden = false;
  question.textContent = "";
  suggestions.replaceChildren(choiceButton("Tell me a new story"));
  status.textContent = "";
}

function setParagraphs(texts: string[]) {
  narration.replaceChildren(
    ...texts.map((text) => {
      const p = document.createElement("p");
      p.textContent = text;
      return p;
    }),
  );
  narration.scrollTop = 0;
}

function choiceButton(choice: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = choice;
  button.addEventListener("click", () => say(choice));
  return button;
}

function showError(message: string) {
  root.dataset.state = "error";
  ask.hidden = true;
  status.textContent = message;
}

/** Tapping a suggestion says it on the listener's behalf: it reaches the host's assistant as a user message. */
async function say(text: string) {
  for (const button of suggestions.querySelectorAll("button")) button.disabled = true;
  status.textContent = "";
  const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
  if (result.isError) {
    for (const button of suggestions.querySelectorAll("button")) button.disabled = false;
  }
}

/** Theme, display mode and scale follow the host. */
function adaptToHost(context: McpUiHostContext | undefined = app.getHostContext()) {
  const theme = context?.theme ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = theme;

  const fullscreen = context?.displayMode === "fullscreen";
  expand.hidden = fullscreen || !context?.availableDisplayModes?.includes("fullscreen");

  // Fullscreen fills the host's screen: scale the base canvas up to it, like Alexa+ does.
  const scale = fullscreen ? Math.max(1, Math.min(innerWidth / BASE.width, innerHeight / BASE.height)) : 1;
  document.documentElement.style.zoom = String(scale);
  root.classList.toggle("is-fixed", fullscreen);
  root.style.height = fullscreen ? `${innerHeight / scale}px` : "";
}

addEventListener("resize", () => adaptToHost());
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => adaptToHost());

app.connect().then(() => adaptToHost());
