import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { contextSnapshotHashV1 } from "../../../src/pactile/agent/context/compaction.js";
import { PactileNativeAgent } from "../../../src/pactile/agent/index.js";
import type { AgentTool } from "../../../src/pactile/agent/pi/types.js";

function assistant(
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "pactile-test",
    model: "mock",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

describe("tool result messages", () => {
  it("stay JSON-clean when a tool reports neither details nor usage", async () => {
    // A tool result with only content: the transcript fingerprints (checkpoint,
    // snapshot hash) refuse a message that carries `usage: undefined`.
    const tool: AgentTool<ReturnType<typeof Type.Object>, undefined> = {
      name: "plain_tool",
      label: "Plain tool",
      description: "Returns content only.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }) as never,
    };
    let calls = 0;
    const agent = new PactileNativeAgent({
      streamFn: () => {
        calls += 1;
        const stream = createAssistantMessageEventStream();
        const message =
          calls === 1
            ? assistant([{ type: "toolCall", id: "call-1", name: "plain_tool", arguments: {} }], "toolUse")
            : assistant([{ type: "text", text: "done" }], "stop");
        queueMicrotask(() =>
          stream.push({ type: "done", reason: calls === 1 ? "toolUse" : "stop", message }),
        );
        return stream;
      },
      initialState: { tools: [tool as never] },
    });
    await agent.prompt("use the tool");
    const result = agent.state.messages.find((message) => message.role === "toolResult");
    expect(result).toBeDefined();
    expect(Object.keys(result ?? {})).not.toContain("usage");
    expect(Object.keys(result ?? {})).not.toContain("details");
    expect(contextSnapshotHashV1(agent.state.messages)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    agent.dispose();
  });
});
