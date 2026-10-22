/**
 * What a spoken reply on the TV means. Most replies are story answers, passed on verbatim;
 * a few short phrases control the player instead.
 */
export type VoiceIntent =
  | { kind: "repeat" }
  | { kind: "choices" }
  | { kind: "end" }
  | { kind: "answer"; text: string };

const REPEAT = /^(please )?(repeat|say (that|it) again|again|what did (you|it) say|pardon|sorry\??)( that| it| please)?\.?$/i;
const CHOICES = /^(what (are|were) (my|the) (choices|options)|what can i (do|say)|(list|read|tell me) (the |my )?(choices|options)|options|choices|help)\??\.?$/i;
const END = /^(please )?(end|finish|stop) (the |this )?story\.?$/i;

export function interpretSpeech(said: string): VoiceIntent {
  const text = said.trim().replace(/\s+/g, " ");
  if (REPEAT.test(text)) return { kind: "repeat" };
  if (CHOICES.test(text)) return { kind: "choices" };
  if (END.test(text)) return { kind: "end" };
  return { kind: "answer", text };
}

/** Spoken list of a scene's suggested answers, e.g. "You could say: open the door, or run." */
export function describeChoices(suggestions: string[]): string {
  if (suggestions.length === 0) return "Say anything you like.";
  const items = suggestions.map((s) => s.toLowerCase());
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
  return `You could say: ${list}. Or say anything you like.`;
}

export interface SpokenReplyActions {
  repeat: () => void;
  choices: () => void;
  end: () => void;
  answer: (text: string) => void;
}

/** Sends a recognised reply to the right place: a player command, or the story as an answer. */
export function routeSpokenReply(said: string, actions: SpokenReplyActions): VoiceIntent {
  const intent = interpretSpeech(said);
  if (intent.kind === "repeat") actions.repeat();
  else if (intent.kind === "choices") actions.choices();
  else if (intent.kind === "end") actions.end();
  else actions.answer(intent.text);
  return intent;
}
