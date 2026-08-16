/**
 * dsh-intercom — Cordis plugin entry. Named exports only (name/inject/apply):
 * the dsh Loader's unwrapExports would collapse a default export.
 *
 * M1 scope: same-process discovery and direct delivery (LocalTransport) plus
 * the intercom tool. The cross-process broker, ask/reply, and mailbox are M2.
 *
 * @module dsh-intercom
 */
import type { Context } from "@deepseek-ai/cordis";
// The ctx.agents / ctx.tools Context merges load program-wide via the imports
// in registry.ts / tool.ts, so this entry needs no type-only imports of its own.
import "./source.ts"; // MessageSourceMap merge: the 'intercom' relay kind
import { SessionRegistry } from "./registry.ts";
import type { SessionTitleLike } from "./registry.ts";
import { createIntercomTool } from "./tool.ts";
import { LocalTransport } from "./transport/local.ts";

export const name = "dsh-intercom";

/** Core services required before the tool can resolve and reach peers. */
export const inject = ["agents", "tools"];

export function apply(ctx: Context): void {
  // ctx.sessionTitle is optional (dsh-session-title may be absent from a
  // minimal profile); aliases then live only in the registry's memory.
  const sessionTitle = ctx.get("sessionTitle") as SessionTitleLike | undefined;
  const registry = new SessionRegistry({ sessionTitle });
  const transport = new LocalTransport((sessionId) =>
    registry.aliasOf(sessionId),
  );

  // Snapshot agents that already exist, then follow the lifecycle. The
  // listeners are registered on the root context and need `global: true` to
  // bypass scope filtering (`agent/*` events are scope-filtered to the agent's
  // own context; a process-wide observer opts out explicitly).
  for (const agent of ctx.agents.list()) registry.add(agent);
  ctx.on("agent/created", ({ agent }) => registry.add(agent), { global: true });
  ctx.on("agent/disposed", ({ agent }) => registry.remove(agent), {
    global: true,
  });

  // Registered globally so every session in the process exposes the tool;
  // `exec.agent` disambiguates the caller.
  ctx.tools.register(createIntercomTool({ registry, transport }));
}
