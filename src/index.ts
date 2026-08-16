/**
 * dsh-intercom — Cordis plugin entry. Named exports only (name/inject/apply):
 * the dsh Loader's unwrapExports would collapse a default export.
 *
 * Wires the in-memory session registry, the same-process LocalTransport
 * (fallback), and the cross-process BrokerTransport (one broker client per
 * agent, auto-spawning the vendored socket broker under `$DSH_HOME/intercom`).
 *
 * @module dsh-intercom
 */
import type { Context } from "@deepseek-ai/cordis";
// The ctx.agents / ctx.tools Context merges load program-wide via the imports
// in registry.ts / tool.ts, so this entry needs no type-only imports of its own.
import "./source.ts"; // MessageSourceMap merge: the 'intercom' relay kind
import { loadConfig } from "./config.ts";
import { SessionRegistry } from "./registry.ts";
import type { SessionTitleLike } from "./registry.ts";
import { createIntercomTool } from "./tool.ts";
import { BrokerTransport } from "./transport/broker.ts";
import { LocalTransport } from "./transport/local.ts";

export const name = "dsh-intercom";

/** Core services required before the tool can resolve and reach peers. */
export const inject = ["agents", "tools"];

export function apply(ctx: Context): void {
  const config = loadConfig((message) => ctx.logger.warn(message));
  // ctx.sessionTitle is optional (dsh-session-title may be absent from a
  // minimal profile); aliases then live only in the registry's memory.
  const sessionTitle = ctx.get("sessionTitle") as SessionTitleLike | undefined;
  const registry = new SessionRegistry({ sessionTitle });
  const local = new LocalTransport((sessionId) => registry.aliasOf(sessionId));
  const broker = new BrokerTransport({
    config,
    aliasOf: (sessionId) => registry.aliasOf(sessionId),
    log: (message) => ctx.logger.warn(message),
  });

  // Snapshot agents that already exist, then follow the lifecycle. The
  // listeners are registered on the root context and need `global: true` to
  // bypass scope filtering (`agent/*` events are scope-filtered to the agent's
  // own context; a process-wide observer opts out explicitly).
  for (const agent of ctx.agents.list()) {
    registry.add(agent);
    broker.attach(agent);
  }
  ctx.on(
    "agent/created",
    ({ agent }) => {
      registry.add(agent);
      broker.attach(agent);
    },
    { global: true },
  );
  ctx.on(
    "agent/disposed",
    ({ agent }) => {
      registry.remove(agent);
      void broker.detach(agent);
    },
    { global: true },
  );
  // Presence: status transitions ride to the broker roster, and an idle
  // transition closes the reply tracker's current turn context.
  ctx.on(
    "agent/status",
    ({ agent, status }) => broker.publishStatus(agent, status),
    { global: true },
  );
  // Reply turn context + delivery confirmation: an intercom relay entering
  // the durable log (user/message) makes its ask the current reply target and
  // cancels the lost-wake redelivery watchdog.
  ctx.on(
    "session/event",
    (session, event) => broker.noteSessionEvent(session, event),
    { global: true },
  );
  ctx.effect(
    () => () => {
      void broker.dispose();
    },
    "dsh-intercom broker transport",
  );

  // Registered globally so every session in the process exposes the tool;
  // `exec.agent` disambiguates the caller.
  ctx.tools.register(createIntercomTool({ registry, local, broker, config }));
}
