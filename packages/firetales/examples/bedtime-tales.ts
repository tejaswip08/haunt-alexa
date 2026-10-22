/**
 * A gentle bedtime story, played automatically: a child picks the first suggestion each
 * time, then the finished story is exported as a narrator-only episode for a speaker.
 * Same engine as Haunt, different genre and audience.
 *
 *   npm run example:bedtime -w @firetales/core
 */
import { createStoryEngine } from "../src/index.ts";
import { providerFromEnv } from "./provider.ts";

const { provider, matcher, label } = await providerFromEnv();
const engine = createStoryEngine({ provider, matcher, prewrite: true });

let turn = await engine.start({
  premise: "a small owl who is afraid of the dark learns the night has friends in it",
  genre: "bedtime adventure",
  audience: "all_ages",
  intensity: "eerie",
  targetScenes: 4,
});

while (turn.scene.question) {
  const choice = turn.scene.question.suggestions[0] ?? "Keep going";
  console.log(`Q: ${turn.scene.question.prompt}  →  "${choice}"`);
  turn = await engine.decide(turn.story.id, choice);
  console.log(`   (${turn.source})`);
}

const episode = await engine.episode(turn.story.id);
console.log(`\n${episode.title} · ${label}\n`);
console.log(episode.script);
console.log(`\n${episode.segments.length} segments, ${episode.wordCount} words, ready for text-to-speech.`);
