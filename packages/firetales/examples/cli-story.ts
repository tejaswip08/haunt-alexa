/**
 * An interactive story in your terminal. Type your answers; the story bends around them.
 *
 *   npm run example:cli -w @firetales/core -- "a map that redraws itself every night"
 *   FIRETALES_PROVIDER=anthropic npm run example:cli -w @firetales/core
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createStoryEngine } from "../src/index.ts";
import { providerFromEnv } from "./provider.ts";

const premise = process.argv.slice(2).join(" ") || "a map that redraws itself every night";
const { provider, matcher, label } = await providerFromEnv();
const engine = createStoryEngine({ provider, matcher, prewrite: true });
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
// An iterator (rather than rl.question) also works when answers are piped in.
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt: string) => {
  stdout.write(prompt);
  const { value, done } = await lines.next();
  if (!stdin.isTTY && !done) stdout.write(`${value}\n`);
  return done ? null : String(value);
};
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

console.log(dim(`FireTales · ${label}\n`));
let turn = await engine.start({ premise, genre: "mystery adventure", audience: "general", intensity: "eerie", targetScenes: 5 });

while (true) {
  const { story, scene } = turn;
  if (scene.index === 0) console.log(`\x1b[1m${story.title}\x1b[0m\n`);
  console.log(scene.narration + "\n");
  if (!scene.question) break;
  console.log(`\x1b[33m${scene.question.prompt}\x1b[0m`);
  if (scene.question.suggestions.length) console.log(dim(`  e.g. ${scene.question.suggestions.join(" / ")}`));
  const answer = (await ask("> "))?.trim();
  if (!answer || /^(quit|exit|end)$/i.test(answer)) {
    turn = await engine.finish(story.id);
    console.log("\n" + turn.scene.narration + "\n");
    break;
  }
  const started = Date.now();
  turn = await engine.decide(story.id, answer);
  console.log(dim(`(${turn.source === "prewritten" ? "pre-written branch" : "written live"}, ${Date.now() - started} ms)\n`));
}

const episode = await engine.episode(turn.story.id);
console.log(dim(`The End. ${episode.wordCount} words, about ${episode.estimatedMinutes} min as an episode.`));
rl.close();
