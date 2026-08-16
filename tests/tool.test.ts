import test from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { IntercomConfig } from "../src/config.ts";
import { SessionRegistry } from "../src/registry.ts";
import { createIntercomTool } from "../src/tool.ts";
import { BrokerTransport } from "../src/transport/broker.ts";
import type {
  DeliveryResult,
  IntercomMessage,
  Transport,
} from "../src/transport/types.ts";
import { fakeAgent } from "./registry.test.ts";

const defaultConfig: IntercomConfig = {
  enabled: true,
  inboundTrigger: "always",
  replyHint: true,
  confirmSend: false,
};

/** A broker transport with no attached sessions → every action falls back local. */
function unattachedBroker(config: IntercomConfig = defaultConfig) {
  return new BrokerTransport({ config, aliasOf: () => undefined });
}

/** Fake transport recording deliveries. */
function recordingTransport(path: DeliveryResult["path"] = "followup") {
  const sent: Array<{ targetId: string; message: IntercomMessage }> = [];
  const transport: Transport = {
    async send(target, message) {
      sent.push({ targetId: String(target.id), message });
      return {
        path,
        target: {
          id: String(target.id),
          alias: undefined,
          cwd: target.session.header.cwd,
          model: undefined,
          status: target.status,
          self: false,
        },
      };
    },
  };
  return { transport, sent };
}

function execFor(agent: Agent | undefined): ToolRunContext {
  return {
    agent,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

function setup() {
  const registry = new SessionRegistry();
  const self = fakeAgent("self-12345678", {
    cwd: "D:/self",
    provider: "deepseek",
    model: "deepseek-chat",
  });
  const worker = fakeAgent("worker-12345678", { cwd: "D:/worker" });
  registry.add(self);
  registry.add(worker);
  registry.alias(worker, "worker");
  const { transport, sent } = recordingTransport();
  const tool = createIntercomTool({
    registry,
    local: transport,
    broker: unattachedBroker(),
    config: defaultConfig,
  });
  return { registry, self, worker, sent, tool };
}

test("list shows the current session and peers", async () => {
  const { self, tool } = setup();
  const out = (await tool.execute({ action: "list" }, execFor(self))) as string;
  assert.match(out, /\*\*Current session:\*\*/);
  assert.match(out, /self-123/);
  assert.match(out, /\[self, idle\]/);
  assert.match(out, /\*\*Other sessions:\*\*/);
  assert.match(out, /worker \(worker-1/);
});

test("name sets the caller alias and makes the sender addressable", async () => {
  const { registry, self, tool } = setup();
  const out = (await tool.execute(
    { action: "name", alias: "planner" },
    execFor(self),
  )) as string;
  assert.match(out, /now named "planner"/);
  assert.equal(registry.aliasOf("self-12345678"), "planner");
});

test("name requires an alias", async () => {
  const { self, tool } = setup();
  await assert.rejects(
    tool.execute({ action: "name" }, execFor(self)),
    /requires a non-empty "alias"/,
  );
});

test("send delivers to a resolved alias and reports the path", async () => {
  const { self, sent, tool } = setup();
  const out = (await tool.execute(
    { action: "send", to: "worker", message: "hello" },
    execFor(self),
  )) as string;
  assert.match(out, /Delivered to/);
  assert.match(out, /via followup/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.targetId, "worker-12345678");
  assert.equal(sent[0]!.message.body, "hello");
  assert.equal(sent[0]!.message.from.sessionId, "self-12345678");
});

test("send validates target and message arguments", async () => {
  const { self, tool } = setup();
  await assert.rejects(
    tool.execute({ action: "send", message: "hi" }, execFor(self)),
    /requires a "to"/,
  );
  await assert.rejects(
    tool.execute({ action: "send", to: "worker" }, execFor(self)),
    /requires a non-empty "message"/,
  );
  await assert.rejects(
    tool.execute(
      { action: "send", to: "worker", message: "   " },
      execFor(self),
    ),
    /non-empty "message"/,
  );
});

test("send rejects unknown, ambiguous, and self targets with clear errors", async () => {
  const { registry, self, tool } = setup();
  await assert.rejects(
    tool.execute({ action: "send", to: "ghost", message: "hi" }, execFor(self)),
    /Unknown session/,
  );
  await assert.rejects(
    tool.execute(
      { action: "send", to: "self-12345678", message: "hi" },
      execFor(self),
    ),
    /current session/,
  );
  const other = fakeAgent("worker-dup-9999");
  registry.add(other);
  registry.alias(other, "worker");
  await assert.rejects(
    tool.execute(
      { action: "send", to: "worker", message: "hi" },
      execFor(self),
    ),
    /Multiple sessions match/,
  );
});

test("send reports steer when the target is busy", async () => {
  const registry = new SessionRegistry();
  const self = fakeAgent("self-12345678");
  const busy = fakeAgent("busy-12345678", { status: "running" });
  registry.add(self);
  registry.add(busy);
  registry.alias(busy, "busy");
  const { transport } = recordingTransport("steer");
  const tool = createIntercomTool({
    registry,
    local: transport,
    broker: unattachedBroker(),
    config: defaultConfig,
  });
  const out = (await tool.execute(
    { action: "send", to: "busy", message: "ping" },
    execFor(self),
  )) as string;
  assert.match(out, /via steer/);
});

test("status reports the local fallback transport and live session count", async () => {
  const { self, tool } = setup();
  const out = (await tool.execute(
    { action: "status" },
    execFor(self),
  )) as string;
  assert.match(out, /local fallback/);
  assert.match(out, /Live sessions in this process: 2/);
});

test("a disabled plugin answers every action but status with a clear message", async () => {
  const registry = new SessionRegistry();
  const self = fakeAgent("self-12345678");
  registry.add(self);
  const config: IntercomConfig = { ...defaultConfig, enabled: false };
  const { transport } = recordingTransport();
  const tool = createIntercomTool({
    registry,
    local: transport,
    broker: unattachedBroker(config),
    config,
  });
  await assert.rejects(
    tool.execute({ action: "list" }, execFor(self)),
    /dsh-intercom is disabled/,
  );
  await assert.rejects(
    tool.execute({ action: "send", to: "x", message: "hi" }, execFor(self)),
    /dsh-intercom is disabled/,
  );
  const status = (await tool.execute(
    { action: "status" },
    execFor(self),
  )) as string;
  assert.match(status, /enabled=false/);
  assert.match(status, /disabled/);
});

test("unknown actions and agent-less executions fail loudly", async () => {
  const { self, tool } = setup();
  await assert.rejects(
    tool.execute({ action: "teleport" }, execFor(self)),
    /must be one of/,
  );
  await assert.rejects(
    tool.execute({ action: "list" }, execFor(undefined)),
    /no calling agent/,
  );
});
