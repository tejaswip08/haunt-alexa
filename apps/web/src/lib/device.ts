import type { CallToolResult } from "@modelcontextprotocol/client";
import { useSyncExternalStore } from "react";
import { clearEvents, record } from "./inspector.ts";
import { countPlayStart } from "./engagement.ts";
import { isGoHome } from "./device-voice.ts";
import { rememberStory } from "./my-stories.ts";
import { connectHaunt, type HauntConnection, type ToolCall } from "./mcp.ts";
import { soundscape } from "./soundscape.ts";
import { describeListenFailure } from "./recognition.ts";
import { browserBrands, canListen, currentEngine, listen, ListenError, speak, stopListening, stopSpeaking } from "./speech.ts";

/**
 * A simulated Alexa+ device. The browser is the MCP host: it holds the conversation,
 * runs tools against the Haunt MCP server and renders their MCP App views. The
 * assistant's decisions come from /api/agent (Claude on Bedrock with the Haunt skill).
 */

export type DeviceState = "connecting" | "idle" | "listening" | "thinking" | "speaking" | "error";

export interface DeviceSnapshot {
  state: DeviceState;
  /** Live transcript of what the device is hearing, or last heard. */
  heard: string;
  /** What the device is saying right now (or said last), for captions on a speaker with no screen. */
  spoken: string;
  /** Latest tool call that has an MCP App view. */
  view: ToolCall | null;
  storyId: string | null;
  error: string | null;
}

type Block = { type: string; [key: string]: unknown };
type Message = { role: "user" | "assistant"; content: string | Block[] };

interface AgentTurn {
  content: Block[];
  stop_reason: string | null;
  model: string;
}

/** The MCP start_story tool's inputs (apps/server/src/mcp.ts). */
export interface StartStoryInput {
  premise: string;
  subgenre?: string;
  length?: "short" | "medium" | "long";
  intensity?: "eerie" | "scary" | "terrifying";
  language?: string;
}

interface SceneResult {
  kind: "scene";
  storyId: string;
  title?: string;
  sceneNumber?: number;
  totalScenes?: number;
  status: "active" | "completed";
  mood: string;
  soundCues: string[];
  narration: string;
  question: string | null;
}

interface EpisodeResult {
  kind: "episode";
  title: string;
  creator: string;
  /** The main storyline as segment indexes. The device narrates that path, not the branches. */
  path?: number[];
  segments: { narration: string; mood: string }[];
}

const MAX_STEPS = 5;

class SimulatedDevice {
  #snapshot: DeviceSnapshot = { state: "connecting", heard: "", spoken: "", view: null, storyId: null, error: null };
  #listeners = new Set<() => void>();
  #connection?: HauntConnection;
  #messages: Message[] = [];
  #flags = { listening: false, thinking: false, speaking: false };
  #busy = false;
  #turn = 0;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = () => this.#snapshot;

  get connection() {
    return this.#connection;
  }

  async connect() {
    if (this.#connection) return this.#connection;
    try {
      this.#connection = await connectHaunt();
      this.#update({ error: null });
      return this.#connection;
    } catch (error) {
      this.#update({ error: `Couldn't reach the Haunt MCP server. ${(error as Error).message}` });
      throw error;
    }
  }

  /** The mic button: interrupts narration, toggles listening. */
  async talk() {
    if (this.#flags.listening) {
      stopListening();
      return;
    }
    stopSpeaking();
    soundscape.unlock();
    this.#flags.listening = true;
    this.#update({ heard: "", error: null });
    try {
      const text = await listen((heard) => this.#update({ heard }));
      this.#flags.listening = false;
      this.#update({ heard: text });
      await this.hear(text);
    } catch (error) {
      this.#flags.listening = false;
      const code = error instanceof ListenError ? error.code : (error as Error)?.name || "unknown";
      // Silence and cancel are normal; everything else gets its real reason.
      // The browser's own speech service failed, but Haunt's server can take over next time.
      const switched = code === "network" && currentEngine() === "server";
      const message =
        code === "no-speech" || code === "aborted"
          ? null
          : switched
            ? "Your browser's speech service isn't available, so Haunt will use its own. Tap the mic again."
            : `${describeListenFailure(code, { brands: browserBrands() }).message} (${code})`;
      this.#update({ error: message });
    }
  }

  /** Something on screen (the Create form) that handles what the listener says before the assistant does. */
  #voiceRouter: ((text: string) => boolean) | null = null;

  /** Lets a screen take spoken commands. Returns a function that removes it again. */
  setVoiceRouter(router: (text: string) => boolean) {
    this.#voiceRouter = router;
    return () => {
      if (this.#voiceRouter === router) this.#voiceRouter = null;
    };
  }

  /** A heard utterance: the screen's voice router takes it when it can, otherwise the assistant answers. */
  async hear(text: string) {
    const utterance = text.trim();
    if (!utterance) return;
    // The screen goes first: on the Haunt app's tabs, "go home" switches to the Home tab.
    if (this.#voiceRouter?.(utterance)) {
      record({ kind: "speech", who: "listener", label: utterance });
      this.#update({ heard: utterance, error: null });
      return;
    }
    // In a story (no app on screen), "go home" leaves the story for the home screen.
    if (isGoHome(utterance)) {
      record({ kind: "speech", who: "listener", label: utterance });
      this.reset();
      return;
    }
    await this.say(utterance);
  }

  /** Handle one thing the listener said, whether spoken or tapped in the scene view. */
  async say(text: string) {
    const utterance = text.trim();
    if (!utterance || this.#busy) return;
    this.#busy = true;
    const turn = ++this.#turn;
    stopSpeaking();
    stopListening();
    soundscape.unlock();
    record({ kind: "speech", who: "listener", label: utterance });
    this.#update({ heard: utterance, error: null });

    let narration: Promise<boolean> | undefined;
    let awaitingAnswer = false;
    try {
      const connection = await this.connect();
      this.#messages.push({ role: "user", content: utterance });

      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await this.#think(connection);
        this.#messages.push({ role: "assistant", content: reply.content });

        if (reply.stop_reason === "refusal") {
          narration ??= this.#speak("Sorry, I can't help with that one.");
          break;
        }
        const toolUses = reply.content.filter((block) => block.type === "tool_use");
        const spoken = reply.content
          .filter((block) => block.type === "text")
          .map((block) => String(block.text))
          .join(" ")
          .trim();
        if (toolUses.length === 0) {
          if (spoken && !narration) narration = this.#speak(spoken);
          break;
        }

        const results: Block[] = [];
        for (const use of toolUses) {
          const call = connection.call(String(use.name), (use.input ?? {}) as Record<string, unknown>);
          if (call.viewHtml) this.#update({ view: call });
          const result = await call.result.catch(
            (error: Error): CallToolResult => ({ isError: true, content: [{ type: "text", text: error.message }] }),
          );
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: Boolean(result.isError), content: textOf(result) });

          const scene = sceneOf(result);
          if (scene) {
            this.#update({ storyId: scene.storyId });
            rememberStory(scene);
            awaitingAnswer = scene.status === "active" && Boolean(scene.question);
            soundscape.setScene(scene.mood, scene.soundCues);
            narration = this.#narrate(scene);
          }
          const episode = episodeOf(result);
          if (episode) narration = this.#narrateEpisode(episode);
        }
        this.#messages.push({ role: "user", content: results });
      }
    } catch (error) {
      record({ kind: "error", label: (error as Error).message, payload: error });
      this.#update({ error: (error as Error).message });
      narration = this.#speak("Sorry, something went wrong.");
    } finally {
      this.#busy = false;
      this.#update({});
    }

    // Follow-up mode: after the narrator asks a question, open the mic for the answer.
    const finished = await narration;
    if (finished && awaitingAnswer && turn === this.#turn && canListen) void this.talk();
  }

  /** A tap on a library card: play that episode directly, the way a touch screen would. */
  async playEpisode(storyId: string) {
    if (this.#busy) return;
    this.#busy = true;
    ++this.#turn;
    stopSpeaking();
    stopListening();
    soundscape.unlock();
    let narration: Promise<boolean> | undefined;
    try {
      const connection = await this.connect();
      const call = connection.call("play_episode", { storyId });
      this.#update({ view: call, error: null });
      const result = await call.result;
      const episode = episodeOf(result);
      if (!episode) throw new Error(textOf(result) || "That episode isn't available.");
      // A library episode's narration is starting: this is one play (engagement.ts).
      countPlayStart(storyId);
      narration = this.#narrateEpisode(episode);
    } catch (error) {
      this.#update({ error: (error as Error).message });
    } finally {
      this.#busy = false;
      this.#update({});
    }
    await narration;
  }

  /**
   * Pick up one of the listener's own stories where it stopped (from My Stories). The call
   * goes into the conversation as if the assistant had made it, so the next answer continues
   * that story.
   */
  async resumeStory(storyId: string) {
    if (this.#busy) return;
    this.reset();
    this.#busy = true;
    const turn = this.#turn;
    soundscape.unlock();
    let narration: Promise<boolean> | undefined;
    let awaitingAnswer = false;
    try {
      const connection = await this.connect();
      const call = connection.call("resume_story", { storyId });
      this.#update({ view: call, error: null });
      const result = await call.result;
      const scene = sceneOf(result);
      if (!scene) throw new Error(textOf(result) || "That story isn't available.");
      const id = `resume_${call.id}`;
      this.#messages.push(
        { role: "user", content: "Continue my earlier story." },
        { role: "assistant", content: [{ type: "tool_use", id, name: "resume_story", input: { storyId } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: textOf(result) }] },
        { role: "assistant", content: [{ type: "text", text: scene.question ?? "The end." }] },
      );
      this.#update({ storyId: scene.storyId });
      rememberStory(scene);
      awaitingAnswer = scene.status === "active" && Boolean(scene.question);
      soundscape.setScene(scene.mood, scene.soundCues);
      narration = this.#narrate(scene);
    } catch (error) {
      this.#update({ error: (error as Error).message });
    } finally {
      this.#busy = false;
      this.#update({});
    }
    const finished = await narration;
    if (finished && awaitingAnswer && turn === this.#turn && canListen) void this.talk();
  }

  /**
   * The on-screen Create form: calls the MCP start_story tool directly with exactly what was chosen, so every field
   * reaches the server as given (and shows in the inspector), then narrates the opening scene like any other story.
   */
  async startStory(input: StartStoryInput) {
    if (this.#busy) return;
    this.reset();
    this.#busy = true;
    const turn = this.#turn;
    soundscape.unlock();
    let narration: Promise<boolean> | undefined;
    let awaitingAnswer = false;
    try {
      const connection = await this.connect();
      const call = connection.call("start_story", { ...input });
      this.#update({ view: call, error: null });
      const result = await call.result;
      const scene = sceneOf(result);
      if (!scene) throw new Error(textOf(result) || "The story didn't start. Try again.");
      // The assistant sees this start as its own tool call, so a spoken answer continues the same story.
      const id = `start_${call.id}`;
      this.#messages.push(
        { role: "user", content: `Start a new story: ${input.premise}` },
        { role: "assistant", content: [{ type: "tool_use", id, name: "start_story", input: { ...input } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: textOf(result) }] },
        { role: "assistant", content: [{ type: "text", text: scene.question ?? "The end." }] },
      );
      this.#update({ storyId: scene.storyId });
      rememberStory(scene);
      awaitingAnswer = scene.status === "active" && Boolean(scene.question);
      soundscape.setScene(scene.mood, scene.soundCues);
      narration = this.#narrate(scene);
    } catch (error) {
      this.#update({ error: (error as Error).message });
    } finally {
      this.#busy = false;
      this.#update({});
    }
    const finished = await narration;
    if (finished && awaitingAnswer && turn === this.#turn && canListen) void this.talk();
  }

  /** Forget the conversation and start fresh. */
  reset() {
    this.#turn++;
    stopSpeaking();
    stopListening();
    this.#messages = [];
    this.#flags = { listening: false, thinking: false, speaking: false };
    soundscape.stop();
    clearEvents();
    this.#update({ heard: "", spoken: "", view: null, storyId: null, error: null });
  }

  async #think(connection: HauntConnection): Promise<AgentTurn> {
    this.#flags.thinking = true;
    this.#update({});
    try {
      const tools = connection.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      record({ kind: "agent", direction: "out", label: `assistant ← ${this.#messages.length} messages`, payload: this.#messages.at(-1) });
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: this.#messages, tools }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Assistant error ${response.status}`);
      const turn = body as AgentTurn;
      const actions = turn.content
        .map((block) => (block.type === "tool_use" ? `calls ${block.name}` : block.type === "text" ? `says “${String(block.text).slice(0, 60)}”` : null))
        .filter(Boolean);
      record({ kind: "agent", direction: "in", label: `assistant → ${actions.join(", ") || "done"}`, payload: turn });
      return turn;
    } finally {
      this.#flags.thinking = false;
      this.#update({});
    }
  }

  /** Read a scene aloud. Resolves true if it played to the end. */
  async #narrate(scene: SceneResult): Promise<boolean> {
    const turn = this.#turn;
    if (!(await this.#speak(scene.narration))) return false;
    if (turn !== this.#turn) return false;
    return this.#speak(scene.question ?? "The end.");
  }

  /** Read an episode straight through, segment by segment. Resolves true if it finished. */
  async #narrateEpisode(episode: EpisodeResult): Promise<boolean> {
    const turn = this.#turn;
    if (!(await this.#speak(`${episode.title}. A Haunt story by ${episode.creator}.`))) return false;
    const path = episode.path ?? episode.segments.map((_, i) => i);
    for (const segment of path.map((i) => episode.segments[i]).filter((s) => s !== undefined)) {
      if (turn !== this.#turn) return false;
      soundscape.setScene(segment.mood);
      if (!(await this.#speak(segment.narration))) return false;
    }
    return true;
  }

  async #speak(text: string): Promise<boolean> {
    const turn = this.#turn;
    record({ kind: "speech", who: "device", label: text });
    this.#flags.speaking = true;
    this.#update({ spoken: text });
    soundscape.duck(true);
    try {
      await speak(text);
    } finally {
      if (turn === this.#turn) {
        this.#flags.speaking = false;
        soundscape.duck(false);
        this.#update({});
      }
    }
    return turn === this.#turn;
  }

  #update(patch: Partial<DeviceSnapshot>) {
    const { listening, thinking, speaking } = this.#flags;
    const next = { ...this.#snapshot, ...patch };
    next.state = !this.#connection && !next.error
      ? "connecting"
      : listening
        ? "listening"
        : speaking
          ? "speaking"
          : thinking || this.#busy
            ? "thinking"
            : next.error
              ? "error"
              : "idle";
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block ? block.text : ""))
    .join("\n");
}

function episodeOf(result: CallToolResult): EpisodeResult | undefined {
  const data = result.structuredContent as Partial<EpisodeResult> | undefined;
  return !result.isError && data?.kind === "episode" ? (data as EpisodeResult) : undefined;
}

function sceneOf(result: CallToolResult): SceneResult | undefined {
  const data = result.structuredContent as Partial<SceneResult> | undefined;
  return !result.isError && data?.kind === "scene" ? (data as SceneResult) : undefined;
}

export const device = new SimulatedDevice();

export function useDevice(): DeviceSnapshot {
  return useSyncExternalStore(device.subscribe, device.getSnapshot);
}
