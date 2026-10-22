import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import { config } from "./config.ts";

let client: AnthropicBedrockMantle | undefined;

/**
 * Claude on Amazon Bedrock. Credentials come from the standard AWS chain
 * (env vars, ~/.aws profile, or an instance role). If the primary model
 * declines a request, it is retried once on the fallback model.
 */
export function bedrock(): AnthropicBedrockMantle {
  client ??= new AnthropicBedrockMantle({
    awsRegion: config.awsRegion,
    middleware: [betaRefusalFallbackMiddleware([{ model: config.fallbackModel }])],
  });
  return client;
}
