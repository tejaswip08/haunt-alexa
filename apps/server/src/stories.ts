import path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createMockProvider, createStoryEngine, createWordMatcher, FileStore } from "@firetales/core";
import { createClaudeAnswerMatcher, createClaudeProvider } from "@firetales/core/claude";
import { createConverseAnswerMatcher, createConverseProvider } from "@firetales/core/converse";
import { DynamoStore } from "@firetales/core/dynamodb";
import { BedrockRuntimeClient, type TokenUsage } from "@aws-sdk/client-bedrock-runtime";
import { bedrock } from "./bedrock.ts";
import { config, dynamoCredentials } from "./config.ts";
import { DynamoLibrary, FileLibrary, type Library } from "./library.ts";

export type { Library, LibraryEntry } from "./library.ts";

export const dynamo =
  config.store === "dynamodb"
    ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion, maxAttempts: 4, retryMode: "standard", credentials: dynamoCredentials() }), {
        marshallOptions: { removeUndefinedValues: true },
      })
    : undefined;

const converse = config.bedrockApi === "converse" ? new BedrockRuntimeClient({ region: config.awsRegion }) : undefined;

/** Running token totals per model, logged after every call so the cost of a story is visible. */
const tokenTotals = new Map<string, { calls: number; input: number; output: number }>();
function logUsage(usage: TokenUsage, model: string) {
  const total = tokenTotals.get(model) ?? { calls: 0, input: 0, output: 0 };
  total.calls += 1;
  total.input += usage.inputTokens ?? 0;
  total.output += usage.outputTokens ?? 0;
  tokenTotals.set(model, total);
  console.log(
    `[bedrock] ${model}: +${usage.inputTokens} in / +${usage.outputTokens} out · total ${total.calls} calls, ${total.input} in / ${total.output} out`,
  );
}

function storyProvider() {
  if (config.storyBackend === "mock") return createMockProvider({ delayMs: 400 });
  if (converse) return createConverseProvider({ client: converse, model: config.storyModel, onUsage: logUsage });
  return createClaudeProvider({ client: bedrock(), model: config.storyModel });
}

function answerMatcher() {
  if (config.storyBackend === "mock") return createWordMatcher();
  if (converse) return createConverseAnswerMatcher({ client: converse, model: config.matchModel, onUsage: logUsage });
  return createClaudeAnswerMatcher({ client: bedrock(), model: config.matchModel });
}

export const engine = createStoryEngine({
  provider: storyProvider(),
  store: dynamo
    ? new DynamoStore({ client: dynamo, table: config.table, keyPrefix: "story#", ttlSeconds: config.storyTtlDays * 86_400, ownerIndex: config.ownerIndex })
    : new FileStore(path.join(config.dataDir, "stories")),
  prewrite: config.prewrite,
  matcher: answerMatcher(),
});

export const library: Library = dynamo
  ? new DynamoLibrary(dynamo, config.table)
  : new FileLibrary(path.join(config.dataDir, "library"));
