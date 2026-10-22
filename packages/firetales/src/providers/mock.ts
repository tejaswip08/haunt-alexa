import type { SceneRequest, StoryProvider } from "../provider.ts";
import type { Mood, Phase, SceneDraft } from "../types.ts";

const MOODS: Mood[] = ["uneasy", "exploration", "suspense", "threat", "revelation"];

/**
 * A deterministic, offline provider. Useful for tests, UI work and demos
 * without model credentials. It follows the same contract as a real provider:
 * clean narration, a separate question, and an ending that asks nothing.
 */
export function createMockProvider(options: { delayMs?: number } = {}): StoryProvider {
  return {
    name: "mock",
    async writeScene(request: SceneRequest): Promise<SceneDraft> {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      const { story } = request;
      const index = story.scenes.length;
      const premise = story.config.premise.replace(/[.!?]+$/, "");
      const ending = request.kind === "ending";
      const answer = "answer" in request ? request.answer : undefined;

      const opening = `It begins the way these things always begin: quietly. ${capitalize(premise)}. The air is colder than it should be, and somewhere close, something is waiting for you to notice it.`;
      const consequence = answer
        ? `You ${lowerFirst(answer.replace(/[.!?]+$/, ""))}. For a moment nothing happens. Then the silence changes shape, the way a room does when someone else has stepped into it.`
        : `The silence changes shape, the way a room does when someone else has stepped into it.`;
      const narration =
        index === 0
          ? opening
          : ending
            ? `${consequence} When the morning finally comes, it finds you exactly where the night left you. But you know now what was waiting, and you know it will wait again.`
            : `${consequence} A sound answers from deeper inside, patient and deliberate.`;

      return {
        title: story.title || `The ${titleWord(premise)}`,
        world: story.world || `A quiet place where ${lowerFirst(premise)}.`,
        decisionOutcome: answer ? `The listener chose to ${lowerFirst(answer.replace(/[.!?]+$/, ""))}.` : "",
        narration,
        mood: ending ? "ending" : (MOODS[index % MOODS.length] ?? "uneasy"),
        soundCues: ending ? ["dawn birdsong", "fading drone"] : ["low wind", "distant creak"],
        visualPrompt: `A dim, cinematic still of ${lowerFirst(premise)}, scene ${index + 1}.`,
        question: ending ? "" : index === 0 ? "Do you step closer, or turn back?" : "Do you follow the sound, or hide?",
        suggestions: ending ? [] : index === 0 ? ["Step closer", "Turn back"] : ["Follow the sound", "Hide"],
        newFacts: index === 0 ? [`The story began with: ${premise}.`] : [],
        newCharacters: [],
        phase: phaseFor(index, story.config.targetScenes, ending),
        isEnding: ending,
      };
    },
  };
}

function phaseFor(index: number, total: number, ending: boolean): Phase {
  if (ending) return "resolution";
  if (index === 0) return "opening";
  return index >= total - 2 ? "climax" : "rising_action";
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function titleWord(premise: string) {
  const word = premise.split(/\s+/).filter((w) => w.length > 3).pop() ?? "Visitor";
  return capitalize(word.replace(/[^A-Za-z]/g, "") || "Visitor");
}
