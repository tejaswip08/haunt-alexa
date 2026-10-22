import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import { bedrock } from "./bedrock.ts";
import { config } from "./config.ts";
import { runConverseAgentTurn } from "./converse-agent.ts";

/**
 * The "brain" of the simulated Alexa+ device. The browser is the host: it owns the
 * conversation, connects to the Haunt MCP server and runs the tools. This endpoint
 * only decides what to say or which tool to call next, using Claude on Bedrock
 * with the Haunt Agent Skill loaded as its instructions.
 */

export const AgentRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
      }),
    )
    .min(1),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      input_schema: z.looseObject({ type: z.literal("object") }),
    }),
  ),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export interface AgentResponse {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.StopReason | null;
  model: string;
  /** "demo" when the offline stand-in answered, so the simulator can say so. */
  mode: "live" | "demo";
}

let converse: BedrockRuntimeClient | undefined;

export async function runAgentTurn(request: AgentRequest): Promise<AgentResponse> {
  if (config.agentBackend === "mock") return mockAgentTurn(request);

  if (config.bedrockApi === "converse") {
    converse ??= new BedrockRuntimeClient({ region: config.awsRegion });
    return runConverseAgentTurn({ client: converse, model: config.agentModel, system: await systemPrompt(), request });
  }

  const response = await bedrock().messages.create({
    model: config.agentModel,
    max_tokens: 4096,
    system: await systemPrompt(),
    tools: request.tools as Anthropic.Tool[],
    messages: request.messages as Anthropic.MessageParam[],
    output_config: { effort: "low" },
  });
  return { content: response.content, stop_reason: response.stop_reason, model: response.model, mode: "live" };
}

let cachedPrompt: string | undefined;

async function systemPrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt;
  const skill = (await readFile(config.skillFile, "utf8")).replace(/^---[\s\S]*?---\s*/, "");
  const prompt = `You are the voice assistant inside a smart display, simulating an Alexa+ experience. People talk to you out loud and everything you say is spoken by a text-to-speech voice, so reply in one or two short, natural sentences with no markdown, lists or emoji.

The Haunt skill is installed on this device. Follow it exactly:

<skill name="haunt">
${skill.trim()}
</skill>

If someone asks for something unrelated to stories, answer briefly and helpfully.`;
  if (config.production) cachedPrompt = prompt;
  return prompt;
}

/** Offline stand-in for the model, so the whole loop works without AWS credentials. */
function mockAgentTurn({ messages }: AgentRequest): AgentResponse {
  const last = messages.at(-1)!;
  const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
  const model = "mock-agent";
  const mode = "demo" as const;

  if (blocks.some((block) => block.type === "tool_result")) {
    return { content: [], stop_reason: "end_turn", model, mode };
  }

  const said = blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join(" ")
    .trim();
  const history = JSON.stringify(messages);
  const storyId = history.match(/st_[a-f0-9]{16}/g)?.at(-1);
  const storyOver = /\\"status\\":\\"completed\\"/.test(history.slice(history.lastIndexOf(storyId ?? "\u0000")));

  const call = (name: string, input: Record<string, unknown>): AgentResponse => ({
    content: [{ type: "tool_use", id: `toolu_mock_${randomUUID().slice(0, 8)}`, name, input, caller: { type: "direct" } }],
    stop_reason: "tool_use",
    model,
    mode,
  });

  if (!storyId || storyOver || /\b(new|another) story\b|\btell me\b/i.test(said)) {
    return call("start_story", { premise: said || "a house that remembers everyone who left it" });
  }
  if (/\b(stop|end the story|end it|that's enough)\b/i.test(said)) {
    return call("end_story", { storyId });
  }
  return call("answer_story", { storyId, answer: said });
}
