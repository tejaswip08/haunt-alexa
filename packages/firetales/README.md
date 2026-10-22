# FireTales

**Build stories that come alive.** FireTales is an open-source engine for voice-first, interactive AI stories that remember every choice.

It handles the hard parts of interactive narrative so your app can focus on the experience:

- **Story state:** world, characters, established facts, choices and dramatic arc, kept consistent from scene to scene.
- **Choices that matter:** each scene ends with a plot-changing question; free-form answers are interpreted, never matched against a menu.
- **Clean episodes:** questions and listener answers are kept separate from the story prose, so any finished story exports as a narrator-only episode.
- **Instant answers:** with `prewrite: true`, the next scene is written for each suggested answer while the listener is still hearing the current one. A matching answer, even in other words, continues in milliseconds; anything else is written live.
- **Pluggable providers:** Claude on Amazon Bedrock (Anthropic-compatible endpoint or the standard Converse API) or the Claude API out of the box, a deterministic mock for tests, or bring your own.
- **Scene artwork:** every scene carries a one-sentence image prompt, and a `SceneImageProvider` turns it into a picture. A free local provider (`createLocalArtProvider`) picks a matching illustration; plug in an image model when you want generated art.
- **Pluggable storage:** in-memory, JSON files, or DynamoDB (`@firetales/core/dynamodb`) out of the box.

> FireTales is an independent open-source project. It is not affiliated with or endorsed by Amazon.

## Quick start

```ts
import { createStoryEngine, createMockProvider } from "@firetales/core";

const engine = createStoryEngine({ provider: createMockProvider() });

const { story, scene } = await engine.start({
  premise: "A young explorer finds a door at the bottom of the sea",
  genre: "fantasy adventure",
  audience: "all_ages",
  intensity: "eerie",
  targetScenes: 5,
});

console.log(scene.narration); // read this aloud
console.log(scene.question?.prompt); // then ask this

const next = await engine.decide(story.id, "Knock three times");
// ...until next.story.status === "completed"

const episode = await engine.episode(story.id); // narration only, ready for TTS
```

### With Claude on Amazon Bedrock

```ts
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { createStoryEngine, FileStore } from "@firetales/core";
import { createClaudeAnswerMatcher, createClaudeProvider } from "@firetales/core/claude";

const client = new AnthropicBedrockMantle({ awsRegion: "us-east-1" });
const engine = createStoryEngine({
  provider: createClaudeProvider({ client, model: "anthropic.claude-sonnet-5-5" }),
  store: new FileStore("./stories"),
  prewrite: true,
  matcher: createClaudeAnswerMatcher({ client, model: "anthropic.claude-haiku-4-5" }),
});
```

### With the Bedrock Converse API

Use this when your AWS account calls Claude through `bedrock-runtime`, for example with an inference profile id:

```ts
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { createStoryEngine, FileStore } from "@firetales/core";
import { createConverseAnswerMatcher, createConverseProvider } from "@firetales/core/converse";

const client = new BedrockRuntimeClient({ region: "us-east-1" });
const model = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const engine = createStoryEngine({
  provider: createConverseProvider({ client, model, onUsage: (usage) => console.log(usage) }),
  store: new FileStore("./stories"),
  prewrite: true,
  matcher: createConverseAnswerMatcher({ client, model }),
});
```

The provider forces a `write_scene` tool call whose schema is FireTales' scene schema, then validates the result, so a malformed reply never reaches your story state.

### Scene artwork

```ts
import { createLocalArtProvider } from "@firetales/core";

const images = createLocalArtProvider();
const image = await images.imageFor(scene, story);
// { art: "lighthouse", alt: scene.visualPrompt, generated: false }
```

`generated` is `true` only when an image model made the picture, so apps can label art honestly.

## Examples

Both run offline with the mock writer. Set `FIRETALES_PROVIDER=anthropic` (with `ANTHROPIC_API_KEY`) or `FIRETALES_PROVIDER=bedrock` (with AWS credentials) to use Claude.

```bash
npm run example:cli -- "a map that redraws itself every night"   # play a mystery in your terminal
npm run example:bedtime                                          # a gentle all-ages story, auto-played and exported
```

The terminal example prints whether each answer used a pre-written branch or was written live.

## Concepts

| Concept | What it is |
| --- | --- |
| `Story` | Config, world, characters, facts, scenes, decisions, status |
| `Scene` | Narration (canonical prose), mood, sound cues, a visual prompt, and an optional question |
| `Decision` | The question, the listener's words, and what the choice meant in-story |
| `StoryProvider` | Anything that turns the story state into the next `SceneDraft` |
| `StoryStore` | Where stories live |
| `Episode` | The finished story as narration-only segments |

## License

Apache-2.0
