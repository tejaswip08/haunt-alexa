import type {
  BedrockRuntimeClient,
  ContentBlock,
  ConverseCommandOutput,
  Message,
  Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import type { AgentRequest, AgentResponse } from "./agent.ts";

/**
 * Runs one assistant turn through Bedrock's Converse API. The browser speaks the
 * Anthropic Messages format (text, tool_use and tool_result blocks), so this module
 * translates both ways and the simulator code doesn't change.
 */

type AnthropicBlock = { type: string; [key: string]: unknown };

export function toConverseMessages(messages: AgentRequest["messages"]): Message[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? [{ text: message.content }]
        : (message.content as AnthropicBlock[]).map(toConverseBlock).filter((block) => block !== undefined),
  }));
}

function toConverseBlock(block: AnthropicBlock): ContentBlock | undefined {
  switch (block.type) {
    case "text":
      return String(block.text ?? "") ? { text: String(block.text) } : undefined;
    case "tool_use":
      return { toolUse: { toolUseId: String(block.id), name: String(block.name), input: (block.input ?? {}) as never } };
    case "tool_result": {
      const content = block.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part: { text?: string }) => part.text ?? "").join("\n")
            : "";
      return {
        toolResult: {
          toolUseId: String(block.tool_use_id),
          content: [{ text: text || "(no output)" }],
          status: block.is_error ? "error" : "success",
        },
      };
    }
    default:
      return undefined;
  }
}

export function toConverseTools(tools: AgentRequest["tools"]): Tool[] {
  return tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description || tool.name,
      inputSchema: { json: tool.input_schema as never },
    },
  }));
}

export function fromConverseOutput(output: Pick<ConverseCommandOutput, "output" | "stopReason">, model: string): AgentResponse {
  const content = (output.output?.message?.content ?? []).flatMap((block): AgentResponse["content"] => {
    if (block.text) return [{ type: "text", text: block.text, citations: null }];
    if (block.toolUse) {
      return [
        {
          type: "tool_use",
          id: block.toolUse.toolUseId ?? "",
          name: block.toolUse.name ?? "",
          input: block.toolUse.input ?? {},
          caller: { type: "direct" },
        },
      ] as AgentResponse["content"];
    }
    return [];
  });
  const stop = output.stopReason;
  const stop_reason =
    stop === "tool_use"
      ? "tool_use"
      : stop === "max_tokens"
        ? "max_tokens"
        : stop === "guardrail_intervened" || stop === "content_filtered"
          ? "refusal"
          : "end_turn";
  return { content, stop_reason, model, mode: "live" };
}

export async function runConverseAgentTurn(options: {
  client: Pick<BedrockRuntimeClient, "send">;
  model: string;
  system: string;
  request: AgentRequest;
  timeoutMs?: number;
}): Promise<AgentResponse> {
  const { client, model, system, request, timeoutMs = 25_000 } = options;
  const output = await client.send(
    new ConverseCommand({
      modelId: model,
      system: [{ text: system }],
      messages: toConverseMessages(request.messages),
      inferenceConfig: { maxTokens: 1024 },
      ...(request.tools.length ? { toolConfig: { tools: toConverseTools(request.tools) } } : {}),
    }),
    { abortSignal: AbortSignal.timeout(timeoutMs) },
  );
  return fromConverseOutput(output, model);
}
