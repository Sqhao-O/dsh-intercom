import test from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  AmbiguousTargetError,
  SessionRegistry,
  UnknownTargetError,
} from "../src/registry.ts";

/** Minimal fake Agent: the registry only reads id/options/session/status. */
export function fakeAgent(
  id: string,
  options: {
    cwd?: string;
    provider?: string;
    model?: string;
    status?: "idle" | "running";
  } = {},
): Agent {
  return {
    id: id as SessionId,
    options: { provider: options.provider, model: options.model },
    session: { header: { cwd: options.cwd } },
    status: options.status ?? "idle",
  } as unknown as Agent;
}

test("add/remove keeps the registry in sync with live agents", () => {
  const registry = new SessionRegistry();
  const a = fakeAgent("session-a", { cwd: "/a" });
  const b = fakeAgent("session-b", { cwd: "/b" });
  registry.add(a);
  registry.add(b);
  assert.equal(registry.list().length, 2);
  registry.remove(a);
  assert.deepEqual(
    registry.list().map((s) => s.id),
    ["session-b"],
  );
  // Removing also drops the alias.
  registry.alias(b, "worker");
  registry.remove(b);
  assert.equal(registry.aliasOf("session-b"), undefined);
});

test("alias mirrors to the session title service when available", () => {
  const renames: Array<{ title: string }> = [];
  const registry = new SessionRegistry({
    sessionTitle: { rename: (_session, title) => renames.push({ title }) },
  });
  const a = fakeAgent("session-a");
  registry.alias(a, "planner");
  assert.equal(registry.aliasOf("session-a"), "planner");
  assert.deepEqual(renames, [{ title: "planner" }]);
});

test("alias works without the title service and tolerates rename failures", () => {
  const failing = new SessionRegistry({
    sessionTitle: {
      rename: () => {
        throw new Error("title invalid");
      },
    },
  });
  const a = fakeAgent("session-a");
  failing.alias(a, "planner");
  assert.equal(failing.aliasOf("session-a"), "planner");

  const bare = new SessionRegistry();
  bare.alias(a, "planner");
  assert.equal(bare.aliasOf("session-a"), "planner");
});

test("alias rejects empty names", () => {
  const registry = new SessionRegistry();
  assert.throws(() => registry.alias(fakeAgent("a"), "   "), /non-empty/);
});

test("resolve hits alias (case-insensitive), full id, and unique id prefix", () => {
  const registry = new SessionRegistry();
  const a = fakeAgent("abc12345-full-id");
  const b = fakeAgent("def67890-full-id");
  registry.add(a);
  registry.add(b);
  registry.alias(a, "Planner");
  assert.equal(registry.resolve("planner"), a);
  assert.equal(registry.resolve("def67890-full-id"), b);
  assert.equal(registry.resolve("def67"), b);
});

test("resolve reports unknown targets with a pointer to list", () => {
  const registry = new SessionRegistry();
  registry.add(fakeAgent("abc12345"));
  assert.throws(() => registry.resolve("nobody"), UnknownTargetError);
  assert.throws(() => registry.resolve("nobody"), /action: "list"/);
});

test("resolve reports ambiguous aliases and prefixes with candidate ids", () => {
  const registry = new SessionRegistry();
  const a = fakeAgent("shared-prefix-aaa");
  const b = fakeAgent("shared-prefix-bbb");
  registry.add(a);
  registry.add(b);
  registry.alias(a, "dup");
  registry.alias(b, "dup");
  assert.throws(() => registry.resolve("dup"), AmbiguousTargetError);
  assert.throws(() => registry.resolve("shared-prefix"), /shared-prefix-aaa/);
});

test("list marks the calling session and summarizes cwd/model/status", () => {
  const registry = new SessionRegistry();
  const self = fakeAgent("self-id", {
    cwd: "/repo",
    provider: "deepseek",
    model: "deepseek-chat",
    status: "running",
  });
  registry.add(self);
  registry.add(fakeAgent("other-id", { status: "idle" }));
  registry.alias(self, "planner");
  const rows = registry.list("self-id");
  const selfRow = rows.find((row) => row.self);
  assert.ok(selfRow);
  assert.equal(selfRow.alias, "planner");
  assert.equal(selfRow.model, "deepseek/deepseek-chat");
  assert.equal(selfRow.status, "running");
  const otherRow = rows.find((row) => !row.self);
  assert.ok(otherRow);
  assert.equal(otherRow.alias, undefined);
});
