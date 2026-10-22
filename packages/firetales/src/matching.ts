/**
 * Decides whether a listener's free-form answer means the same choice as one of the
 * scene's suggestions, so a pre-written branch can be used instead of writing live.
 * A wrong match would put words in the listener's mouth, so matchers must be conservative.
 */
export interface AnswerMatcher {
  /** Index of the matching option, or null when the answer differs in any meaningful way. */
  match(answer: string, options: string[], context: { question: string }): Promise<number | null>;
}

const NEGATIONS = new Set(["not", "no", "never", "dont", "don't", "wont", "won't", "cant", "can't", "cannot", "nothing", "neither", "nor"]);
const STOPWORDS = new Set([
  "a", "an", "the", "i", "i'll", "ill", "i'm", "im", "we", "let's", "lets", "to", "and", "then", "it", "its", "that",
  "this", "of", "on", "in", "at", "for", "with", "my", "me", "go", "just", "will", "would", "should", "do", "ok",
  "okay", "yes", "yeah", "please", "um", "uh", "so", "um", "well", "think", "want", "try", "gonna",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length > 2 && !STOPWORDS.has(w) && !NEGATIONS.has(w)));
}

function negated(text: string): boolean {
  return words(text).some((w) => NEGATIONS.has(w) || w.endsWith("n't"));
}

/**
 * Offline matcher: exact or near-exact wording only. Matches "I'll follow the sound" to
 * "Follow the sound", but never "Don't follow the sound", and never an answer that adds
 * new intent ("follow the sound and call for help").
 */
export function createWordMatcher(): AnswerMatcher {
  return {
    async match(answer, options) {
      const said = contentWords(answer);
      if (said.size === 0) return null;
      const candidates = options
        .map((option, index) => ({ index, words: contentWords(option), negated: negated(option) }))
        .filter((option) => option.words.size > 0 && option.negated === negated(answer))
        .filter((option) => [...option.words].every((w) => said.has(w)))
        // Extra words in the answer usually mean extra intent; allow at most one.
        .filter((option) => said.size - option.words.size <= 1);
      return candidates.length === 1 ? candidates[0]!.index : null;
    },
  };
}
