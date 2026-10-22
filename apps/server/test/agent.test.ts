import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeAwsError } from "../src/aws-errors.ts";
import { fromConverseOutput, runConverseAgentTurn, toConverseMessages, toConverseTools } from "../src/converse-agent.ts";

const tools = [
  { name: "start_story", description: "Start a story", input_schema: { type: "object" as const, properties: { premise: { type: "string" } } } },
];

describe("Converse assistant", () => {
  it("translates Anthropic messages, tool calls and tool results", () => {
    const messages = toConverseMessages([
      { role: "user", content: "Tell me a ghost story" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "start_story", input: { premise: "ghost" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "{}" }] }] },
    ]);
    assert.deepEqual(messages[0], { role: "user", content: [{ text: "Tell me a ghost story" }] });
    assert.deepEqual(messages[1]!.content![0], { toolUse: { toolUseId: "t1", name: "start_story", input: { premise: "ghost" } } });
    assert.deepEqual(messages[2]!.content![0], { toolResult: { toolUseId: "t1", content: [{ text: "{}" }], status: "success" } });
  });

  it("marks failed tool results as errors", () => {
    const [message] = toConverseMessages([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] },
    ]);
    assert.equal(message!.content![0]!.toolResult?.status, "error");
  });

  it("translates tool definitions", () => {
    assert.deepEqual(toConverseTools(tools)[0], {
      toolSpec: { name: "start_story", description: "Start a story", inputSchema: { json: tools[0]!.input_schema } },
    });
  });

  it("translates the reply back, including tool calls and refusals", () => {
    const reply = fromConverseOutput(
      {
        stopReason: "tool_use",
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Here we go." }, { toolUse: { toolUseId: "t2", name: "start_story", input: { premise: "x" } } }],
          },
        },
      },
      "haiku",
    );
    assert.equal(reply.stop_reason, "tool_use");
    assert.equal(reply.mode, "live");
    assert.deepEqual(reply.content.map((block) => block.type), ["text", "tool_use"]);
    assert.equal(fromConverseOutput({ stopReason: "content_filtered", output: undefined }, "haiku").stop_reason, "refusal");
  });

  it("sends the system prompt, tools and a timeout to Bedrock", async () => {
    let sent: { input?: { modelId?: string; system?: unknown; toolConfig?: { tools?: unknown[] } }; signal?: unknown } = {};
    const client = {
      send: async (command: { input: unknown }, options: { abortSignal?: unknown }) => {
        sent = { input: command.input as never, signal: options.abortSignal };
        return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text: "Hi." }] } } };
      },
    };
    const reply = await runConverseAgentTurn({
      client: client as never,
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      system: "Be brief.",
      request: { messages: [{ role: "user", content: "hello" }], tools },
    });
    assert.equal(reply.content[0]?.type, "text");
    assert.equal(sent.input?.modelId, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
    assert.deepEqual(sent.input?.system, [{ text: "Be brief." }]);
    assert.equal(sent.input?.toolConfig?.tools?.length, 1);
    assert.ok(sent.signal instanceof AbortSignal);
  });
});

describe("AWS error messages", () => {
  const cases: [unknown, number, RegExp][] = [
    [{ name: "ThrottlingException" }, 429, /busy/],
    [{ name: "TimeoutError" }, 504, /too long/],
    [{ name: "AccessDeniedException", message: "x is not available for this account" }, 503, /isn't allowed/],
    [{ name: "CredentialsProviderError", message: "Could not load credentials" }, 503, /credentials/],
    [{ name: "ValidationException", message: "The provided model identifier is invalid." }, 503, /model id/],
    [new Error("socket hang up"), 502, /unavailable/],
  ];
  for (const [error, status, reason] of cases) {
    it(`maps ${(error as { name: string }).name} to ${status}`, () => {
      const friendly = describeAwsError(error);
      assert.equal(friendly.status, status);
      assert.match(friendly.reason, reason);
    });
  }
});

describe("Story retention setting", () => {
  it("reads days, keeps 0 as 'never', and falls back on invalid values", async () => {
    const { ttlDays } = await import("../src/config.ts");
    assert.equal(ttlDays(undefined), 30);
    assert.equal(ttlDays("45"), 45);
    assert.equal(ttlDays("0"), 0);
    assert.equal(ttlDays("abc"), 30);
    assert.equal(ttlDays("-5"), 30);
  });
});
