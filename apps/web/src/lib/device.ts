import type { CallToolResult } from "@modelcontextprotocol/client";
import { useSyncExternalStore } from "react";
import { clearEvents, record } from "./inspector.ts";
import { countPlayStart } from "./engagement.ts";
import { SUBGENRES } from "./create-voice.ts";
import { isGoHome } from "./device-voice.ts";
import { isCancel, nextSegment, parseListenControl, parsePlayMode, pickOption, type PlayMode } from "./play-mode.ts";
import { rememberStory } from "./my-stories.ts";
import { session } from "./session.ts";
import { connectHaunt, type HauntConnection, type ToolCall } from "./mcp.ts";
import { soundscape } from "./soundscape.ts";
import { describeListenFailure } from "./recognition.ts";
import { browserBrands, canListen, currentEngine, listen, ListenError, narrate, speak, stopListening, stopSpeaking, type Narration } from "./speech.ts";

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
  /** Set while the screen asks "How do you want to play?" before a story. */
  pick: PlayModeRequest | null;
  /** A library episode playing on the device, segment by segment. */
  episode: EpisodePlayback | null;
  /** "Just listen": the story plays like a film, with a timeline, and never stops to ask. */
  listen: ListenPlayback | null;
}

export interface ListenPart {
  narration: string;
  mood: string;
}

export interface ListenPlayback {
  storyId: string;
  title: string;
  creator?: string;
  parts: ListenPart[];
  /** Parts the story is expected to have. A story being written grows toward it. */
  total: number;
  /** Parts heard before this session (a continued story starts partway); the timeline shows them as done. */
  offset: number;
  /** The part playing (or about to). Equal to parts.length while the next part is being written. */
  at: number;
  paused: boolean;
  /** Waiting for the next part to be written. */
  writing: boolean;
  ended: boolean;
  /** For the timeline: when the current part last started or resumed playing (null while not playing), and how long it had played before that. */
  playingSince: number | null;
  playedMs: number;
}

export type { PlayMode };

/** The story the listener is about to play, for the "How do you want to play?" screen. */
export interface PlayModeRequest {
  kind: "episode" | "new" | "continue";
  title: string;
  detail?: string;
}

export interface EpisodePlayback {
  storyId: string;
  title: string;
  creator: string;
  mode: PlayMode;
  segments: EpisodeSegment[];
  /** The segment being narrated. */
  at: number;
  /** Segments played so far, in order. */
  played: number[];
  /** Set while waiting for the listener to pick at a choice point. */
  choices: EpisodeSegment["choices"] | null;
  ended: boolean;
}

export interface EpisodeSegment {
  narration: string;
  mood: string;
  choices?: { prompt: string; options: { label: string; next: number }[] };
  next?: number;
  ending?: boolean;
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
  /** Answers the view offers; "just listen" takes the first. */
  suggestions?: string[];
}

interface EpisodeResult {
  kind: "episode";
  storyId?: string;
  title: string;
  creator: string;
  summary?: string;
  /** The main storyline as segment indexes: what "just listen" plays. */
  path?: number[];
  segments: EpisodeSegment[];
}

/** The tools that begin a story, so the device asks how to play first (when the assistant calls them too). */
const STORY_STARTS = new Set(["start_story", "resume_story", "play_episode"]);

const MAX_STEPS = 5;

class SimulatedDevice {
  #snapshot: DeviceSnapshot = { state: "connecting", heard: "", spoken: "", view: null, storyId: null, error: null, pick: null, episode: null, listen: null };
  /** How the current story plays. Chosen before each story. */
  #mode: PlayMode = "choices";
  #answerPick?: (mode: PlayMode | null) => void;
  #answerChoice?: (option: number | null) => void;
  /** The scene whose question is waiting for the listener's answer. Answers go straight to answer_story (see say). */
  #awaiting: SceneResult | null = null;
  /** The "just listen" player: bumped to stop a running narration loop; the narration speaking now; where parts come from. */
  #listenGen = 0;
  #listenNarration?: Narration;
  #listenSource?: { kind: "episode" } | { kind: "story"; scene: SceneResult; writing?: Promise<boolean> };
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
    // The mic during "just listen" pauses the story (it holds its place) rather than cutting it off.
    if (this.#snapshot.listen && !this.#snapshot.listen.paused && !this.#snapshot.listen.ended) this.pauseListen();
    else stopSpeaking();
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

  /**
   * Says a line from the device itself (the Echo's spoken menus), then opens the mic for the answer.
   * Interrupts anything being said. Resolves when the line has been spoken.
   */
  async prompt(text: string, listenAfter = true) {
    stopSpeaking();
    soundscape.unlock();
    this.#update({ error: null });
    const finished = await this.#speak(text);
    if (finished && listenAfter && canListen && !this.#flags.listening && !this.#snapshot.pick) void this.talk();
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
    // "How do you want to play?" is open: "with choices", "just listen", or "cancel".
    if (this.#snapshot.pick) {
      record({ kind: "speech", who: "listener", label: utterance });
      const mode = parsePlayMode(utterance);
      if (mode) this.choosePlayMode(mode);
      else if (isCancel(utterance) || isGoHome(utterance)) this.choosePlayMode(null);
      else this.#update({ heard: utterance, error: "Say “with choices” or “just listen”." });
      return;
    }
    // The "just listen" player: "pause", "resume", "next", "previous", "start over"; "go home" leaves it.
    if (this.#snapshot.listen) {
      const control = parseListenControl(utterance);
      if (control) {
        record({ kind: "speech", who: "listener", label: utterance });
        this.#update({ heard: utterance, error: null });
        if (control === "pause") this.pauseListen();
        else if (control === "resume") this.resumeListen();
        else if (control === "next") this.nextPart();
        else if (control === "previous") this.previousPart();
        else this.jumpTo(0);
        return;
      }
      if (isGoHome(utterance)) {
        record({ kind: "speech", who: "listener", label: utterance });
        this.reset();
        return;
      }
    }
    // An episode is waiting at a choice point: "two", "follow the sound".
    const waiting = this.#snapshot.episode?.choices;
    if (waiting) {
      const option = pickOption(utterance, waiting.options.map((o) => o.label));
      if (option !== null) {
        record({ kind: "speech", who: "listener", label: utterance });
        this.chooseOption(option);
        return;
      }
    }
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
    // A story is waiting for an answer: send it straight to the story tools, word for word (as the Haunt skill does),
    // instead of a round trip through the assistant. Only asking for a different story goes to the assistant.
    const waiting = this.#awaiting;
    if (waiting && !/\b(?:new|different|another) story\b|^(?:tell me|create|make) /i.test(utterance)) {
      return this.#answerStory(waiting, utterance);
    }
    this.#awaiting = null;
    this.#endListen();
    this.#busy = true;
    const turn = ++this.#turn;
    stopSpeaking();
    stopListening();
    soundscape.unlock();
    record({ kind: "speech", who: "listener", label: utterance });
    this.#update({ heard: utterance, error: null });

    let narration: Promise<boolean> | undefined;
    let awaitingAnswer = false;
    let lastScene: SceneResult | undefined;
    let listening = false;
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
        let cancelled = false;
        for (const use of toolUses) {
          if (STORY_STARTS.has(String(use.name)) && !cancelled) {
            const input = (use.input ?? {}) as Record<string, unknown>;
            const mode = await this.#askMode(requestFor(String(use.name), input));
            if (!mode) cancelled = true;
            else this.#mode = mode;
          }
          if (cancelled) {
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "The listener decided not to play right now." });
            continue;
          }
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
            if (this.#mode === "listen" && STORY_STARTS.has(String(use.name))) {
              // Just listening: the player takes over and the question is never asked.
              listening = true;
              this.#listenToStory(scene);
            } else {
              awaitingAnswer = scene.status === "active" && Boolean(scene.question);
              this.#awaiting = awaitingAnswer ? scene : null;
              lastScene = scene;
              soundscape.setScene(scene.mood, scene.soundCues);
              narration = this.#narrate(scene);
            }
          }
          const episode = episodeOf(result);
          if (episode) {
            const episodeId = String((use.input as { storyId?: unknown })?.storyId ?? episode.storyId ?? "");
            countPlayStart(episodeId);
            if (this.#mode === "listen") {
              listening = true;
              this.#listenToEpisode(episode, episodeId);
            } else narration = this.#narrateEpisode(episode, episodeId);
          }
        }
        this.#messages.push({ role: "user", content: results });
        if (listening) break;
        if (cancelled) {
          narration ??= this.#speak("Okay. Maybe later.");
          break;
        }
      }
    } catch (error) {
      record({ kind: "error", label: (error as Error).message, payload: error });
      this.#update({ error: (error as Error).message });
      narration = this.#speak("Sorry, something went wrong.");
    } finally {
      this.#busy = false;
      this.#update({});
    }

    // Follow-up mode: after the narrator asks a question, open the mic for the answer (or carry on, when just listening).
    const finished = await narration;
    if (finished && awaitingAnswer && turn === this.#turn) this.#afterScene(lastScene);
  }

  /**
   * The listener's answer to the scene waiting for one: answer_story with exactly what they said, or end_story for
   * "stop" / "end the story". The call is added to the conversation as the assistant's own, so it can carry on later.
   */
  async #answerStory(scene: SceneResult, answer: string) {
    this.#awaiting = null;
    this.#busy = true;
    const turn = ++this.#turn;
    stopSpeaking();
    stopListening();
    soundscape.unlock();
    record({ kind: "speech", who: "listener", label: answer });
    this.#update({ heard: answer, error: null });
    const ending = /^(?:stop|end(?: the| this)? story|end it|finish(?: the story)?|that's enough|i'm done|quit)(?: please)?$/i.test(answer.replace(/[.!?]+$/, ""));
    // "Two" or "the first one" means that suggestion: send its words, as the assistant did.
    const suggestions = scene.suggestions ?? [];
    const position = /^(?:the )?(?:option |number )?(?:one|two|three|four|first|second|third|fourth|[1-4])(?: one| option)?$/i.test(answer.replace(/[.!?]+$/, ""))
      ? pickOption(answer, suggestions)
      : null;
    const said = position !== null ? suggestions[position]! : answer;
    const tool = ending ? "end_story" : "answer_story";
    const input: Record<string, unknown> = ending ? { storyId: scene.storyId } : { storyId: scene.storyId, answer: said };
    let narration: Promise<boolean> | undefined;
    let next: SceneResult | undefined;
    try {
      const connection = await this.connect();
      const call = connection.call(tool, input);
      this.#update({ view: call });
      const result = await call.result;
      next = sceneOf(result);
      if (!next) throw new Error(textOf(result) || "The story couldn't continue.");
      const id = `answer_${call.id}`;
      if (this.#messages.at(-1)?.role === "user") this.#messages.push({ role: "assistant", content: [{ type: "text", text: scene.question ?? "What do you do?" }] });
      this.#messages.push(
        { role: "user", content: said },
        { role: "assistant", content: [{ type: "tool_use", id, name: tool, input }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: textOf(result) }] },
        { role: "assistant", content: [{ type: "text", text: next.question ?? "The end." }] },
      );
      this.#update({ storyId: next.storyId });
      rememberStory(next);
      // The new question is open at once, so an answer said (or tapped) during the narration goes straight in too.
      this.#awaiting = next.status === "active" && next.question ? next : null;
      soundscape.setScene(next.mood, next.soundCues);
      narration = this.#narrate(next);
    } catch (error) {
      record({ kind: "error", label: (error as Error).message, payload: error });
      // Keep the question open, so saying the answer again tries again.
      this.#awaiting = scene;
      this.#update({ error: (error as Error).message });
      narration = this.#speak("Sorry, that didn't go through. Say your answer again.");
    } finally {
      this.#busy = false;
      this.#update({});
    }
    const finished = await narration;
    if (turn !== this.#turn) return;
    if (next && next.status === "active" && next.question) {
      if (finished) this.#afterScene(next);
    } else if (!next && finished && canListen) void this.talk();
  }

  /** After a scene's question: open the mic for the answer. */
  #afterScene(_scene: SceneResult | undefined) {
    if (canListen) void this.talk();
  }

  /**
   * Shows "How do you want to play?" and waits for a tap or "with choices" / "just listen".
   * Resolves null when the listener cancels or something else takes over.
   */
  async #askMode(request: PlayModeRequest): Promise<PlayMode | null> {
    this.#answerPick?.(null);
    const answer = new Promise<PlayMode | null>((resolve) => (this.#answerPick = resolve));
    this.#update({ pick: request, error: null });
    const turn = this.#turn;
    void this.#speak("How do you want to play? With choices, or just listen?").then((done) => {
      if (done && turn === this.#turn && this.#snapshot.pick === request && canListen && !this.#flags.listening) void this.talk();
    });
    const mode = await answer;
    if (this.#snapshot.pick === request) this.#update({ pick: null });
    return mode;
  }

  /** The answer to "How do you want to play?" (null cancels). */
  choosePlayMode(mode: PlayMode | null) {
    const resolve = this.#answerPick;
    if (!resolve) return;
    this.#answerPick = undefined;
    stopSpeaking();
    stopListening();
    this.#update({ pick: null });
    resolve(mode);
  }

  /** Close the "How do you want to play?" screen without playing. */
  cancelPlayMode() {
    this.choosePlayMode(null);
  }

  /** The option picked at an episode's choice point. */
  chooseOption(option: number) {
    const resolve = this.#answerChoice;
    if (!resolve) return;
    this.#answerChoice = undefined;
    stopSpeaking();
    stopListening();
    resolve(option);
  }

  /** A tap on a library card: play that episode directly, the way a touch screen would. */
  async playEpisode(storyId: string, about?: { title?: string; summary?: string }) {
    if (this.#busy || this.#snapshot.pick) return;
    this.reset();
    soundscape.unlock();
    const mode = await this.#askMode({ kind: "episode", title: about?.title ?? "This story", detail: about?.summary });
    if (!mode) return;
    this.#mode = mode;
    this.#busy = true;
    let narration: Promise<boolean> | undefined;
    try {
      const connection = await this.connect();
      const call = connection.call("play_episode", { storyId });
      this.#update({ error: null });
      const result = await call.result;
      const episode = episodeOf(result);
      if (!episode) throw new Error(textOf(result) || "That episode isn't available.");
      // A library episode's narration is starting: this is one play (engagement.ts).
      countPlayStart(storyId);
      if (mode === "listen") this.#listenToEpisode(episode, storyId);
      else narration = this.#narrateEpisode(episode, storyId);
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
  async resumeStory(storyId: string, title?: string) {
    if (this.#busy || this.#snapshot.pick) return;
    this.reset();
    soundscape.unlock();
    const mode = await this.#askMode({ kind: "continue", title: title ?? "Your story", detail: "Pick up where you left off." });
    if (!mode) return;
    this.#mode = mode;
    this.#busy = true;
    const turn = this.#turn;
    soundscape.unlock();
    let narration: Promise<boolean> | undefined;
    let awaitingAnswer = false;
    let lastScene: SceneResult | undefined;
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
      if (mode === "listen") this.#listenToStory(scene);
      else {
        awaitingAnswer = scene.status === "active" && Boolean(scene.question);
        this.#awaiting = awaitingAnswer ? scene : null;
        lastScene = scene;
        soundscape.setScene(scene.mood, scene.soundCues);
        narration = this.#narrate(scene);
      }
    } catch (error) {
      this.#update({ error: (error as Error).message });
    } finally {
      this.#busy = false;
      this.#update({});
    }
    const finished = await narration;
    if (finished && awaitingAnswer && turn === this.#turn) this.#afterScene(lastScene);
  }

  /**
   * The on-screen Create form: calls the MCP start_story tool directly with exactly what was chosen, so every field
   * reaches the server as given (and shows in the inspector), then narrates the opening scene like any other story.
   */
  async startStory(input: StartStoryInput) {
    if (this.#busy || this.#snapshot.pick) return;
    this.reset();
    soundscape.unlock();
    const mode = await this.#askMode(requestFor("start_story", input as unknown as Record<string, unknown>));
    if (!mode) return;
    this.#mode = mode;
    this.#busy = true;
    const turn = this.#turn;
    soundscape.unlock();
    let narration: Promise<boolean> | undefined;
    let awaitingAnswer = false;
    let lastScene: SceneResult | undefined;
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
      if (mode === "listen") this.#listenToStory(scene);
      else {
        awaitingAnswer = scene.status === "active" && Boolean(scene.question);
        this.#awaiting = awaitingAnswer ? scene : null;
        lastScene = scene;
        soundscape.setScene(scene.mood, scene.soundCues);
        narration = this.#narrate(scene);
      }
    } catch (error) {
      this.#update({ error: (error as Error).message });
    } finally {
      this.#busy = false;
      this.#update({});
    }
    const finished = await narration;
    if (finished && awaitingAnswer && turn === this.#turn) this.#afterScene(lastScene);
  }

  /** Forget the conversation and start fresh. */
  reset() {
    this.#turn++;
    stopSpeaking();
    stopListening();
    this.#messages = [];
    this.#flags = { listening: false, thinking: false, speaking: false };
    this.#mode = "choices";
    this.#answerPick?.(null);
    this.#answerPick = undefined;
    this.#answerChoice?.(null);
    this.#answerChoice = undefined;
    this.#awaiting = null;
    this.#endListen();
    soundscape.stop();
    clearEvents();
    this.#update({ heard: "", spoken: "", view: null, storyId: null, error: null, pick: null, episode: null, listen: null });
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
      // With the listener's sign-in, so the deployed server (which needs an account for the assistant) accepts it.
      const response = await session.fetch("/api/agent", {
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

  // ---- "Just listen": a film-like player with a timeline, pause and skip. It never asks the story's questions. ----

  /** A story being written (start_story / resume_story): plays its parts and writes the next one in the background. */
  #listenToStory(scene: SceneResult) {
    this.#listenSource = { kind: "story", scene };
    this.#startListen({
      storyId: scene.storyId,
      title: scene.title || "Your story",
      parts: [{ narration: scene.narration, mood: scene.mood }],
      total: Math.max(scene.totalScenes ?? 1, scene.sceneNumber ?? 1),
      offset: Math.max(0, (scene.sceneNumber ?? 1) - 1),
      ended: false,
    });
  }

  /** A library episode: its main storyline, every part already written. */
  #listenToEpisode(episode: EpisodeResult, storyId: string) {
    this.#listenSource = { kind: "episode" };
    const path = episode.path ?? episode.segments.map((_, i) => i);
    const parts = path.map((i) => episode.segments[i]).filter((s): s is EpisodeSegment => s !== undefined);
    this.#startListen({
      storyId,
      title: episode.title,
      creator: episode.creator,
      parts: parts.map((s) => ({ narration: s.narration, mood: s.mood })),
      total: parts.length,
      offset: 0,
      ended: false,
    });
  }

  #startListen(base: Pick<ListenPlayback, "storyId" | "title" | "creator" | "parts" | "total" | "offset" | "ended">) {
    this.#flags.speaking = false;
    this.#update({ view: null, episode: null, listen: { ...base, at: 0, paused: false, writing: false, playingSince: null, playedMs: 0 } });
    void this.#runListen(++this.#listenGen);
  }

  #setListen(patch: Partial<ListenPlayback>) {
    const current = this.#snapshot.listen;
    if (current) this.#update({ listen: { ...current, ...patch } });
  }

  /** Narrates parts in order until paused, jumped, or finished. A newer run (higher generation) replaces this one. */
  async #runListen(gen: number) {
    while (gen === this.#listenGen) {
      const playback = this.#snapshot.listen;
      if (!playback || playback.ended || playback.paused) return;
      const source = this.#listenSource;

      if (playback.at >= playback.parts.length) {
        // Past the written parts: wait for the next one, or the story is over.
        const more = source?.kind === "story" && source.scene.status === "active";
        if (more) {
          this.#setListen({ writing: true });
          const written = await this.#writeNextPart();
          if (gen !== this.#listenGen) return;
          this.#setListen({ writing: false });
          if (written) continue;
        }
        this.#setListen({ ended: true, writing: false, playingSince: null, at: Math.max(0, playback.parts.length - 1) });
        record({ kind: "speech", who: "device", label: "The end." });
        this.#listenNarration = narrate("The end.");
        return;
      }

      const part = playback.parts[playback.at]!;
      soundscape.setScene(part.mood);
      soundscape.duck(true);
      // While the last written part plays, the next one is written, so there's no wait between them.
      if (source?.kind === "story" && playback.at === playback.parts.length - 1) void this.#writeNextPart();
      record({ kind: "speech", who: "device", label: part.narration });
      const narration = narrate(part.narration);
      this.#listenNarration = narration;
      this.#setListen({ playingSince: Date.now(), playedMs: 0 });
      const end = await narration.done;
      if (gen !== this.#listenGen) return;
      soundscape.duck(false);
      // Cancelled by something else (the mic, another narration): hold here, the play button continues.
      if (end === "cancelled") {
        this.#setListen({ paused: true, playingSince: null, playedMs: 0 });
        return;
      }
      const now = this.#snapshot.listen;
      if (!now) return;
      this.#setListen({ at: now.at + 1, playingSince: null, playedMs: 0 });
    }
  }

  /** Writes the story's next part by answering its question with the first suggestion. One at a time. */
  #writeNextPart(): Promise<boolean> {
    const source = this.#listenSource;
    if (source?.kind !== "story") return Promise.resolve(false);
    if (source.writing) return source.writing;
    const scene = source.scene;
    if (scene.status !== "active" || !scene.question) return Promise.resolve(false);
    const answer = scene.suggestions?.[0] ?? "Keep going";
    source.writing = (async () => {
      const connection = await this.connect();
      record({ kind: "speech", who: "listener", label: `${answer} (just listening)` });
      const call = connection.call("answer_story", { storyId: scene.storyId, answer });
      const result = await call.result;
      const next = sceneOf(result);
      if (!next) throw new Error(textOf(result) || "The story couldn't continue.");
      if (this.#listenSource !== source) return false;
      // The assistant sees this as its own call, so speaking up later continues the same story.
      const id = `listen_${call.id}`;
      if (this.#messages.at(-1)?.role === "user") this.#messages.push({ role: "assistant", content: [{ type: "text", text: scene.question ?? "" }] });
      this.#messages.push(
        { role: "user", content: answer },
        { role: "assistant", content: [{ type: "tool_use", id, name: "answer_story", input: { storyId: scene.storyId, answer } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: textOf(result) }] },
        { role: "assistant", content: [{ type: "text", text: next.question ?? "The end." }] },
      );
      source.scene = next;
      rememberStory(next);
      const playback = this.#snapshot.listen;
      if (playback) {
        const parts = [...playback.parts, { narration: next.narration, mood: next.mood }];
        this.#setListen({ parts, total: Math.max(next.totalScenes ?? playback.total, playback.offset + parts.length) });
      }
      return true;
    })()
      .catch((error: Error) => {
        this.#update({ error: error.message });
        return false;
      })
      .finally(() => {
        source.writing = undefined;
      });
    return source.writing;
  }

  /** Pause: the voice holds its place where it can; otherwise the part starts again on resume. */
  pauseListen() {
    const playback = this.#snapshot.listen;
    if (!playback || playback.paused || playback.ended) return;
    const played = playback.playedMs + (playback.playingSince ? Date.now() - playback.playingSince : 0);
    if (this.#listenNarration?.pause()) {
      this.#setListen({ paused: true, playingSince: null, playedMs: played });
    } else {
      this.#listenGen++;
      this.#listenNarration?.cancel();
      this.#setListen({ paused: true, playingSince: null, playedMs: 0 });
    }
    soundscape.duck(false);
  }

  resumeListen() {
    const playback = this.#snapshot.listen;
    if (!playback || !playback.paused) return;
    if (this.#listenNarration?.resume()) {
      this.#setListen({ paused: false, playingSince: Date.now() });
      soundscape.duck(true);
    } else {
      this.#setListen({ paused: false, playedMs: 0 });
      void this.#runListen(++this.#listenGen);
    }
  }

  togglePauseListen() {
    if (this.#snapshot.listen?.paused) this.resumeListen();
    else this.pauseListen();
  }

  /** Jump to a part on the timeline (one already written, or the next one being written). */
  jumpTo(index: number) {
    const playback = this.#snapshot.listen;
    if (!playback) return;
    const canWrite = this.#listenSource?.kind === "story" && this.#listenSource.scene.status === "active";
    const last = canWrite ? playback.parts.length : playback.parts.length - 1;
    this.#listenGen++;
    this.#listenNarration?.cancel();
    // Past the last part of a finished story: that's the end.
    if (index > last) {
      this.#setListen({ ended: true, paused: false, writing: false, playingSince: null, playedMs: 0, at: Math.max(0, playback.parts.length - 1) });
      soundscape.duck(false);
      return;
    }
    const at = Math.max(0, index);
    this.#setListen({ at, paused: false, ended: false, writing: false, playingSince: null, playedMs: 0 });
    void this.#runListen(this.#listenGen);
  }

  nextPart() {
    const playback = this.#snapshot.listen;
    if (playback) this.jumpTo(playback.at + 1);
  }

  /** Back to the start of this part, or to the part before when it has only just begun. */
  previousPart() {
    const playback = this.#snapshot.listen;
    if (!playback) return;
    const played = playback.playedMs + (playback.playingSince ? Date.now() - playback.playingSince : 0);
    this.jumpTo(played > 3000 || playback.ended ? playback.at : playback.at - 1);
  }

  #endListen() {
    if (!this.#snapshot.listen && !this.#listenSource) return;
    this.#listenGen++;
    this.#listenNarration?.cancel();
    this.#listenNarration = undefined;
    this.#listenSource = undefined;
    if (this.#snapshot.listen) this.#update({ listen: null });
  }

  /**
   * Play a library episode on the screen, segment by segment. "Just listen" follows the main storyline; "with choices"
   * stops at each choice point and waits for a tap or a spoken option. Resolves true if it reached the end.
   */
  async #narrateEpisode(episode: EpisodeResult, storyId: string): Promise<boolean> {
    const turn = this.#turn;
    const mode = this.#mode;
    let playback: EpisodePlayback = {
      storyId,
      title: episode.title,
      creator: episode.creator,
      mode,
      segments: episode.segments,
      at: 0,
      played: [],
      choices: null,
      ended: false,
    };
    const show = (patch: Partial<EpisodePlayback>) => {
      playback = { ...playback, ...patch };
      if (turn === this.#turn) this.#update({ episode: playback, view: null });
    };
    show({});
    if (!(await this.#speak(`${episode.title}. A Haunt story by ${episode.creator}.`))) return false;

    let at: number | undefined = 0;
    const seen = new Set<number>();
    while (at !== undefined && !seen.has(at)) {
      if (turn !== this.#turn) return false;
      seen.add(at);
      const segment: EpisodeSegment | undefined = episode.segments[at];
      if (!segment) break;
      show({ at, played: [...playback.played, at], choices: null });
      soundscape.setScene(segment.mood);
      if (!(await this.#speak(segment.narration))) return false;

      let option = 0;
      if (segment.choices && mode === "choices") {
        show({ choices: segment.choices });
        const picked = new Promise<number | null>((resolve) => (this.#answerChoice = resolve));
        const options = segment.choices.options.map((o, i) => `${i === 0 ? "One" : i === 1 ? "Two" : i === 2 ? "Three" : "Four"}: ${o.label}.`).join(" ");
        void this.#speak(`${segment.choices.prompt} ${options}`).then((done) => {
          if (done && turn === this.#turn && playback.choices && canListen && !this.#flags.listening) void this.talk();
        });
        const choice = await picked;
        if (choice === null || turn !== this.#turn) return false;
        option = choice;
        record({ kind: "speech", who: "listener", label: segment.choices.options[choice]?.label ?? "" });
        show({ choices: null });
      }
      at = nextSegment(episode.segments, at, option);
    }
    show({ ended: true, choices: null });
    return this.#speak("The end.");
  }

  /** Play the same episode again from the start (the end screen's button). */
  async replayEpisode() {
    const current = this.#snapshot.episode;
    if (current) await this.playEpisode(current.storyId, { title: current.title });
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
    const { listening, thinking } = this.#flags;
    const next = { ...this.#snapshot, ...patch };
    const playing = next.listen && !next.listen.paused && !next.listen.ended && !next.listen.writing;
    const speaking = this.#flags.speaking || Boolean(playing);
    next.state = !this.#connection && !next.error
      ? "connecting"
      : listening
        ? "listening"
        : speaking
          ? "speaking"
          : thinking || (this.#busy && !next.pick)
            ? "thinking"
            : next.error
              ? "error"
              : "idle";
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

/** What the "How do you want to play?" screen says about a story the assistant (or Create) is about to begin. */
function requestFor(tool: string, input: Record<string, unknown>): PlayModeRequest {
  if (tool === "play_episode") return { kind: "episode", title: "A story from the library" };
  if (tool === "resume_story") return { kind: "continue", title: "Your story", detail: "Pick up where you left off." };
  const premise = typeof input.premise === "string" ? input.premise.trim() : "";
  const subgenre = SUBGENRES.find((s) => s.id === input.subgenre)?.name;
  return { kind: "new", title: subgenre ? `A new ${subgenre} story`.replace(" Story story", " story") : "A new story", detail: premise || undefined };
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
