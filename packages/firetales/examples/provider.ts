import { createMockProvider, createWordMatcher, type AnswerMatcher, type StoryProvider } from "../src/index.ts";
import { createClaudeAnswerMatcher, createClaudeProvider } from "../src/providers/claude.ts";

/**
 * Picks a provider from the environment so the examples run anywhere:
 *   FIRETALES_PROVIDER=anthropic  Claude API (needs ANTHROPIC_API_KEY)
 *   FIRETALES_PROVIDER=bedrock    Claude on Amazon Bedrock (needs AWS credentials)
 *   anything else                 the offline mock
 */
export async function providerFromEnv(): Promise<{ provider: StoryProvider; matcher: AnswerMatcher; label: string }> {
  const choice = process.env.FIRETALES_PROVIDER;
  if (choice === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    return {
      provider: createClaudeProvider({ client, model: "claude-sonnet-5-5" }),
      matcher: createClaudeAnswerMatcher({ client, model: "claude-haiku-4-5" }),
      label: "Claude API (claude-sonnet-5-5)",
    };
  }
  if (choice === "bedrock") {
    const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
    const client = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION ?? "us-east-1" });
    return {
      provider: createClaudeProvider({ client, model: "anthropic.claude-sonnet-5-5" }),
      matcher: createClaudeAnswerMatcher({ client, model: "anthropic.claude-haiku-4-5" }),
      label: "Claude on Amazon Bedrock",
    };
  }
  return { provider: createMockProvider(), matcher: createWordMatcher(), label: "offline mock (set FIRETALES_PROVIDER for Claude)" };
}
