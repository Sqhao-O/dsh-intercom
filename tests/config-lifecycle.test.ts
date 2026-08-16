/**
 * Lifecycle hardening: `enabled: false` in `$DSH_HOME/intercom/config.json`
 * must load the plugin without EVER spawning or connecting to the broker, and
 * every tool action except `status` must answer with the disabled message.
 *
 * Integration-level: the config is read from a real file in a scratch
 * DSH_HOME through the real `loadConfig`, and the BrokerTransport is built
 * with instrumented (counting) spawn/client hooks so any broker attempt would
 * be caught; the absence of broker runtime files in the scratch home is
 * asserted on top.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { getBrokerSocketPath } from "../broker/paths.ts";
import { loadConfig } from "../src/config.ts";
import { SessionRegistry } from "../src/registry.ts";
import { createIntercomTool } from "../src/tool.ts";
import { BrokerTransport } from "../src/transport/broker.ts";
import { LocalTransport } from "../src/transport/local.ts";

const homeDir = mkdtempSync(path.join(tmpdir(), "dsh-intercom-disabled-"));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = homeDir;
process.on("exit", () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  rmSync(homeDir, { recursive: true, force: true });
});

function fakeAgent(id: string): Agent {
  const parked: UserMessage[] = [];
  return {
    id: id as SessionId,
    options: { provider: "deepseek", model: "deepseek-chat" },
    session: { header: { cwd: "D:/self" } },
    status: "idle",
    inbox: {
      get nextTurn() {
        return parked;
      },
      get nextStep() {
        return [] as readonly UserMessage[];
      },
    },
    followup(message: UserMessage) {
      parked.push(message);
    },
    steer(message: UserMessage) {
      parked.push(message);
    },
    inject() {},
  } as unknown as Agent;
}

function execFor(agent: Agent): ToolRunContext {
  return {
    agent,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext;
}

test(
  "enabled: false never spawns or connects the broker and disables all actions but status",
  { concurrency: false, timeout: 15_000 },
  async () => {
    const intercomDir = path.join(homeDir, "intercom");
    mkdirSync(intercomDir, { recursive: true });
    writeFileSync(
      path.join(intercomDir, "config.json"),
      JSON.stringify({ enabled: false }),
      "utf8",
    );

    const warnings: string[] = [];
    const config = loadConfig((message) => warnings.push(message));
    assert.equal(config.enabled, false);
    assert.deepEqual(warnings, []);

    let spawnAttempts = 0;
    let clientCreations = 0;
    const registry = new SessionRegistry();
    const self = fakeAgent("disabled-self");
    registry.add(self);
    const broker = new BrokerTransport({
      config,
      aliasOf: (id) => registry.aliasOf(id),
      spawnBroker: () => {
        spawnAttempts += 1;
        return Promise.resolve();
      },
      createClient: () => {
        clientCreations += 1;
        throw new Error("unreachable");
      },
    });
    const local = new LocalTransport((id) => registry.aliasOf(id));
    const tool = createIntercomTool({ registry, local, broker, config });

    broker.attach(self);
    // Give any erroneous background connect ample time to fire.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(spawnAttempts, 0, "disabled config must not spawn the broker");
    assert.equal(clientCreations, 0, "disabled config must not create clients");
    assert.equal(broker.sessionFor("disabled-self"), undefined);
    assert.deepEqual(broker.health(), {
      enabled: false,
      registered: 0,
      connected: 0,
      errors: [],
    });

    // No broker runtime artifacts in the scratch home (broker.pid is written
    // by the broker process on startup; the socket/pipe exists only while a
    // broker listens).
    assert.equal(existsSync(path.join(intercomDir, "broker.pid")), false);
    if (process.platform !== "win32") {
      assert.equal(
        existsSync(getBrokerSocketPath(process.platform, homeDir)),
        false,
      );
    }

    for (const args of [
      { action: "list" },
      { action: "list-cwd" },
      { action: "send", to: "x", message: "hi" },
      { action: "ask", to: "x", message: "hi" },
      { action: "reply", message: "hi" },
      { action: "pending" },
      { action: "cancel", messageId: "m-1" },
      { action: "name", alias: "x" },
    ] as const) {
      await assert.rejects(
        tool.execute(args, execFor(self)),
        /dsh-intercom is disabled/,
        `${args.action} should be disabled`,
      );
    }

    const status = (await tool.execute(
      { action: "status" },
      execFor(self),
    )) as string;
    assert.match(status, /enabled=false/);
    assert.match(status, /disabled/);

    // Still nothing after exercising the tool.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(spawnAttempts, 0);
    assert.equal(clientCreations, 0);
    await broker.dispose();
  },
);
