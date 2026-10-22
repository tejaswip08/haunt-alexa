import type { SceneDraft, Story } from "./types.ts";

export type SceneRequest =
  /** Write the first scene from the premise alone. */
  | { kind: "opening"; story: Story }
  /** The listener answered the last scene's question; write what happens next. */
  | { kind: "continue"; story: Story; answer: string }
  /** Write the final scene. `answer` is set when it follows a decision. */
  | { kind: "ending"; story: Story; answer?: string };

/**
 * Writes scenes. FireTales ships a Claude provider (Claude API or Amazon Bedrock)
 * and a deterministic mock; anything that returns a valid SceneDraft works.
 */
export interface StoryProvider {
  readonly name: string;
  writeScene(request: SceneRequest): Promise<SceneDraft>;
}

/** The provider declined to write the scene (for example, a safety refusal). */
export class StoryRefusalError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "StoryRefusalError";
  }
}
