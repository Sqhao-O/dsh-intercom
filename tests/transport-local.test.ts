import test from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import { LocalTransport } from "../src/transport/local.ts";
import type { IntercomMessage } from "../src/transport/types.ts";

/** Fake Agent recording followup/steer/inject deliveries. */
function recordingAgent(id: string, status: "idle" | "running") {
  const calls: Array<{
    method: "followup" | "steer" | "inject";
    message: UserMessage;
  }> = [];
  const agent = {
    id: id as SessionId,
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { cwd: "D:/target" } },
    status,
    followup(message: UserMessage) {
      calls.push({ method: "followup", message });
    },
    steer(message: UserMessage) {
      calls.push({ method: "steer", message });
    },
    inject(message: UserMessage) {
      calls.push({ method: "inject", message });
    },
  } as unknown as Agent;
  return { agent, calls };
}

function outbound(): IntercomMessage {
  return {
    from: {
      sessionId: "sender-full-id",
      display: "planner",
      address: "planner",
      cwd: "D:/sender",
    },
    body: "hello worker",
  };
}

test("idle target receives the message via followup", async () => {
  const { agent, calls } = recordingAgent("target-id", "idle");
  const transport = new LocalTransport(() => "worker");
  const result = await transport.send(agent, outbound());
  assert.equal(result.path, "followup");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "followup");
  assert.equal(result.target.id, "target-id");
  assert.equal(result.target.alias, "worker");
});

test("running target receives the message via steer", async () => {
  const { agent, calls } = recordingAgent("target-id", "running");
  const transport = new LocalTransport(() => undefined);
  const result = await transport.send(agent, outbound());
  assert.equal(result.path, "steer");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "steer");
});

test("injected message is a relay from the sender with the formatted body", async () => {
  const { agent, calls } = recordingAgent("target-id", "idle");
  const transport = new LocalTransport(() => undefined);
  await transport.send(agent, outbound());
  const delivered = calls[0]!.message;
  assert.equal(delivered.role, "user");
  assert.deepEqual(delivered.source, {
    kind: "intercom",
    form: "relay",
    senderSessionId: "sender-full-id",
  });
  const text = delivered.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.match(text, /\*\*From planner\*\* \(D:\/sender\)/);
  assert.match(text, /action: "send", to: "planner"/);
  assert.ok(text.endsWith("hello worker"));
});
