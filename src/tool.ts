/**
 * The `intercom` tool definition: one tool, multiple actions, matching
 * pi-intercom's semantics (`list` / `list-cwd` / `send` / `ask` / `reply` /
 * `pending` / `status` / `cancel` / `name`).
 *
 * Delivery routing: when the calling agent has a live broker client, actions
 * run against the cross-process broker roster (including mailbox queueing for
 * named disconnected targets). When the broker is unavailable, same-process
 * targets still work through LocalTransport; broker-only actions (`ask`,
 * `reply`, `cancel`) then fail with a clear error.
 */
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { sameCwd } from "../cwd.ts";
import type { SessionInfo } from "../types.ts";
import type { IntercomConfig } from "./config.ts";
import {
  formatSessionList,
  formatSessionListRow,
  sessionIdPrefixes,
} from "./message.ts";
import type { SessionRegistry } from "./registry.ts";
import type {
  BrokerClientLike,
  BrokerSession,
  BrokerTransport,
} from "./transport/broker.ts";
import type { SessionSummary, Transport } from "./transport/types.ts";

/** Short id prefix shown in lists; a unique leading prefix resolves as a target. */
const ID_PREFIX_LENGTH = 8;

export interface IntercomToolDeps {
  readonly registry: SessionRegistry;
  /** Same-process direct delivery (fallback and M1 path). */
  readonly local: Transport;
  readonly broker: BrokerTransport;
  readonly config: IntercomConfig;
}

interface DeliveryTarget {
  readonly id: string;
  readonly label: string;
}

function summarizeRow(
  summary: SessionSummary,
  currentCwd: string | undefined,
): string {
  return formatSessionListRow({
    display: summary.alias ?? "Unnamed session",
    idPrefix: summary.id.slice(0, ID_PREFIX_LENGTH),
    cwd: summary.cwd,
    model: summary.model,
    status: summary.status,
    self: summary.self,
    sameCwd: summary.cwd !== undefined && summary.cwd === currentCwd,
  });
}

function brokerRow(
  session: SessionInfo,
  currentCwd: string | undefined,
  isSelf: boolean,
  idPrefix: string,
): string {
  return formatSessionListRow({
    display: session.name ?? "Unnamed session",
    idPrefix,
    cwd: session.cwd,
    model: session.model,
    status: session.status ?? "unknown",
    self: isSelf,
    sameCwd:
      !isSelf && currentCwd !== undefined && sameCwd(session.cwd, currentCwd),
  });
}

function requireSelf(agent: Agent | undefined): Agent {
  if (!agent)
    throw new Error(
      "intercom: no calling agent context (the tool must run inside an agent turn).",
    );
  return agent;
}

/** Sender display + reply address for outbound messages from `self`. */
function senderOf(
  deps: IntercomToolDeps,
  self: Agent,
): { display: string; address: string } {
  const id = String(self.id);
  const alias = deps.registry.aliasOf(id);
  return {
    display: alias ?? id.slice(0, ID_PREFIX_LENGTH),
    address: alias ?? id,
  };
}

function requireMessage(message: string | undefined, action: string): string {
  if (typeof message !== "string" || !message.trim()) {
    throw new Error(
      `intercom: "${action}" requires a non-empty "message" parameter.`,
    );
  }
  return message;
}

/**
 * Resolve a name, full session id, or unique id prefix against the broker
 * roster (ported pi-intercom semantics: exact id, then exact name, then
 * prefix). Returns null when nothing matches — the broker itself resolves
 * raw names once more (including disconnected mailbox targets), so callers
 * pass `resolved ?? to` to `client.send`.
 */
async function resolveSessionTarget(
  client: BrokerClientLike,
  nameOrId: string,
): Promise<string | null> {
  const sessions = await client.listSessions();
  const byId = sessions.find((session) => session.id === nameOrId);
  if (byId) {
    return byId.id;
  }
  const lowerName = nameOrId.toLowerCase();
  const byName = sessions.filter(
    (session) => session.name?.toLowerCase() === lowerName,
  );
  if (byName.length > 1) {
    const prefixes = sessionIdPrefixes(sessions.map((session) => session.id));
    const ids = byName.map((session) => prefixes.get(session.id)!).join(", ");
    throw new Error(
      `Multiple sessions named "${nameOrId}" are connected. Address one by the id shown in parentheses by "list" (${ids}).`,
    );
  }
  if (byName.length === 1) {
    return byName[0]!.id;
  }

  const byIdPrefix = sessions.filter((session) =>
    session.id.startsWith(nameOrId),
  );
  if (byIdPrefix.length === 1) {
    return byIdPrefix[0]!.id;
  }
  if (byIdPrefix.length > 1) {
    throw new Error(
      `Multiple sessions match ID prefix "${nameOrId}". Use a longer session ID prefix.`,
    );
  }
  return null;
}

/**
 * Resolve the delivery target for a `cwd`-scoped send/ask: the sole live peer
 * in that directory, or the `to`-named session verified to live there.
 */
async function resolveCwdTarget(
  client: BrokerClientLike,
  options: { to?: string; cwd: string },
): Promise<DeliveryTarget> {
  const sessions = await client.listSessions();
  const current = sessions.find((session) => session.id === client.sessionId);
  if (!current) {
    throw new Error("Current session is missing from intercom session list.");
  }
  const targetCwd =
    options.cwd && options.cwd !== "."
      ? resolvePath(current.cwd, options.cwd)
      : current.cwd;
  const candidates = sessions.filter(
    (session) =>
      session.id !== client.sessionId && sameCwd(session.cwd, targetCwd),
  );

  if (options.to) {
    const resolved = await resolveSessionTarget(client, options.to);
    const match = candidates.find((session) => session.id === resolved);
    if (!match) {
      throw new Error(
        `Session "${options.to}" is not connected in ${targetCwd}.`,
      );
    }
    return { id: match.id, label: options.to };
  }
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return { id: only.id, label: only.name ?? only.id };
  }
  if (candidates.length === 0) {
    throw new Error(`No intercom session is connected in ${targetCwd}.`);
  }
  throw new Error(
    `Multiple sessions are connected in ${targetCwd}; specify "to".`,
  );
}

export function createIntercomTool(deps: IntercomToolDeps): ToolDefinition {
  const disabledError =
    'dsh-intercom is disabled (enabled: false in $DSH_HOME/intercom/config.json). Set "enabled": true and restart to use it.';

  /** The calling agent's connected broker client, when available. */
  async function connectedClient(
    selfId: string,
  ): Promise<{ session: BrokerSession; client: BrokerClientLike } | undefined> {
    if (!deps.config.enabled) return undefined;
    const session = deps.broker.sessionFor(selfId);
    if (!session) return undefined;
    try {
      return { session, client: await session.ensureConnected() };
    } catch {
      return undefined;
    }
  }

  /** Like connectedClient, but throws a clear error for broker-only actions. */
  async function requireBroker(
    selfId: string,
    action: string,
  ): Promise<{ session: BrokerSession; client: BrokerClientLike }> {
    if (!deps.config.enabled) {
      throw new Error(disabledError);
    }
    const session = deps.broker.sessionFor(selfId);
    if (!session) {
      throw new Error(
        `intercom: "${action}" needs the cross-process broker, which is not available for this session.`,
      );
    }
    try {
      return { session, client: await session.ensureConnected() };
    } catch (error) {
      throw new Error(
        `intercom: "${action}" needs the cross-process broker, but it is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return defineTool({
    name: "intercom",
    description:
      "Exchange messages with other live dsh sessions on this machine. Use to coordinate with peer sessions: " +
      "list them, give the current session a name, send a message, ask and block until the reply arrives, " +
      "reply to an inbound ask, list pending asks, or cancel a message you sent. Address sessions by alias, " +
      'full session id, or the short id prefix shown in parentheses by "list". Inbound messages arrive as a ' +
      "relay from the named sender: idle sessions start a new turn with it, busy sessions receive it as " +
      "steering at the next step boundary.",
    parameters: {
      action: {
        type: "string",
        enum: [
          "list",
          "list-cwd",
          "send",
          "ask",
          "reply",
          "pending",
          "status",
          "cancel",
          "name",
        ],
        required: true,
        description:
          "'list': show live sessions. 'list-cwd': show sessions in a working directory. 'send': deliver a message. " +
          "'ask': send and block until the reply arrives. 'reply': reply to an inbound ask. 'pending': list unresolved " +
          "inbound asks. 'cancel': request cancellation of a sent message. 'name': set this session's alias. " +
          "'status': intercom plugin status.",
      },
      to: {
        type: "string",
        description:
          "Target session: alias, full session id, or the unique id prefix shown by 'list'. For 'reply', disambiguates the pending ask.",
      },
      message: {
        type: "string",
        description: "Message text for 'send', 'ask', and 'reply'.",
      },
      alias: {
        type: "string",
        description:
          "Alias to give the current session for 'name'. Other sessions address you by this name.",
      },
      replyTo: {
        type: "string",
        description:
          "Message id to reply to (for threading or responding to an 'ask').",
      },
      messageId: {
        type: "string",
        description:
          "Message id for actions that operate on an existing message, such as 'cancel'; also overrides the id of a new 'send'.",
      },
      supersedes: {
        type: "string",
        description:
          "Previous message id this send/ask explicitly supersedes. Only works for the same sender and receiver.",
      },
      retryOf: {
        type: "string",
        description:
          "Previous message id this send/ask is a user-authored retry of. Retries always send a new message id.",
      },
      cwd: {
        type: "string",
        description:
          "Working directory filter for 'list-cwd'. For send/ask, scopes target lookup to that directory; omit 'to' to target the sole live peer there. Absolute, or relative to the current session's cwd; '.' means the current cwd.",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    execute: async (args, exec) => {
      const self = requireSelf(exec.agent);
      const selfId = String(self.id);

      if (!deps.config.enabled && args.action !== "status") {
        throw new Error(disabledError);
      }

      switch (args.action) {
        case "list": {
          const connected = await connectedClient(selfId);
          if (connected) {
            const sessions = await connected.client.listSessions();
            const prefixes = sessionIdPrefixes(
              sessions.map((session) => session.id),
            );
            const current = sessions.find(
              (session) => session.id === connected.client.sessionId,
            );
            const others = sessions.filter(
              (session) => session.id !== connected.client.sessionId,
            );
            return formatSessionList(
              current
                ? brokerRow(
                    current,
                    current.cwd,
                    true,
                    prefixes.get(current.id)!,
                  )
                : undefined,
              others.map((session) =>
                brokerRow(
                  session,
                  current?.cwd,
                  false,
                  prefixes.get(session.id)!,
                ),
              ),
            );
          }
          const sessions = deps.registry.list(selfId);
          const current = sessions.find((session) => session.self);
          const others = sessions.filter((session) => !session.self);
          return formatSessionList(
            current ? summarizeRow(current, current.cwd) : undefined,
            others.map((session) => summarizeRow(session, current?.cwd)),
          );
        }

        case "list-cwd": {
          const connected = await connectedClient(selfId);
          if (connected) {
            const sessions = await connected.client.listSessions();
            const current = sessions.find(
              (session) => session.id === connected.client.sessionId,
            );
            if (!current) {
              throw new Error(
                "Current session is missing from intercom session list.",
              );
            }
            const filterCwd =
              args.cwd && args.cwd !== "."
                ? resolvePath(current.cwd, args.cwd)
                : current.cwd;
            const others = sessions.filter(
              (session) =>
                session.id !== connected.client.sessionId &&
                sameCwd(session.cwd, filterCwd),
            );
            const prefixes = sessionIdPrefixes(
              sessions.map((session) => session.id),
            );
            const rows = others.map((session) =>
              brokerRow(session, current.cwd, false, prefixes.get(session.id)!),
            );
            const header = `**Other sessions (cwd: ${filterCwd}):**`;
            const otherSection =
              rows.length === 0
                ? `${header}\nNo other sessions in this directory.`
                : `${header}\n${rows.join("\n")}`;
            return `${`**Current session:**\n${brokerRow(current, current.cwd, true, prefixes.get(current.id)!)}`}\n\n${otherSection}`;
          }
          const sessions = deps.registry.list(selfId);
          const current = sessions.find((session) => session.self);
          const baseCwd = current?.cwd ?? self.session.header.cwd;
          const filterCwd =
            args.cwd && args.cwd !== "." && baseCwd
              ? resolvePath(baseCwd, args.cwd)
              : baseCwd;
          const rows = sessions
            .filter((session) => !session.self)
            .filter(
              (session) =>
                session.cwd !== undefined &&
                filterCwd !== undefined &&
                sameCwd(session.cwd, filterCwd),
            )
            .map((session) => summarizeRow(session, current?.cwd));
          const header = `**Other sessions (cwd: ${filterCwd ?? "unknown"}):**`;
          const otherSection =
            rows.length === 0
              ? `${header}\nNo other sessions in this directory.`
              : `${header}\n${rows.join("\n")}`;
          const currentSection = current
            ? `**Current session:**\n${summarizeRow(current, current.cwd)}`
            : undefined;
          return [currentSection, otherSection]
            .filter((section): section is string => Boolean(section))
            .join("\n\n");
        }

        case "name": {
          const alias = args.alias?.trim();
          if (!alias)
            throw new Error(
              'intercom: "name" requires a non-empty "alias" parameter.',
            );
          deps.registry.alias(self, alias);
          deps.broker.publishName(self);
          return `This session is now named "${alias}" (${selfId.slice(0, ID_PREFIX_LENGTH)}). Other sessions can reach it with intercom({ action: "send", to: "${alias}", message: "..." }).`;
        }

        case "send": {
          const to = args.to?.trim();
          const cwd = args.cwd?.trim();
          if (!to && !cwd)
            throw new Error(
              'intercom: "send" requires a "to" parameter (alias or session id) or a "cwd" scope.',
            );
          const body = requireMessage(args.message, "send");

          const connected = await connectedClient(selfId);
          if (!connected) {
            if (
              cwd ||
              args.replyTo ||
              args.messageId ||
              args.supersedes ||
              args.retryOf
            ) {
              throw new Error(
                "intercom: replyTo/messageId/supersedes/retryOf/cwd need the cross-process broker, which is unavailable; plain same-process sends still work.",
              );
            }
            const target = deps.registry.resolve(to!);
            if (String(target.id) === selfId) {
              throw new Error(
                'intercom: target resolves to the current session; pick a peer from "list".',
              );
            }
            const sender = senderOf(deps, self);
            const result = await deps.local.send(target, {
              from: {
                sessionId: selfId,
                ...sender,
                cwd: self.session.header.cwd,
              },
              body,
            });
            const name = result.target.alias ?? result.target.id;
            const how =
              result.path === "followup"
                ? "the session was idle and starts a new turn with it"
                : "the session was busy and receives it as steering at its next step boundary";
            return `Delivered to ${name} (${result.target.id.slice(0, ID_PREFIX_LENGTH)}) via ${result.path}: ${how}.`;
          }

          const { session, client } = connected;
          const target: DeliveryTarget = cwd
            ? await resolveCwdTarget(client, { ...(to ? { to } : {}), cwd })
            : {
                id: (await resolveSessionTarget(client, to!)) ?? to!,
                label: to!,
              };
          if (target.id === client.sessionId) {
            throw new Error("intercom: cannot message the current session.");
          }
          const inferredAsk = args.replyTo
            ? null
            : session.tracker.findUniquePendingAskFrom(target.id);
          const effectiveReplyTo = args.replyTo ?? inferredAsk?.message.id;
          const result = await client.send(target.id, {
            text: body,
            ...(effectiveReplyTo ? { replyTo: effectiveReplyTo } : {}),
            ...(args.messageId ? { messageId: args.messageId } : {}),
            ...(args.supersedes ? { supersedes: args.supersedes } : {}),
            ...(args.retryOf ? { retryOf: args.retryOf } : {}),
          });
          if (!result.delivered) {
            throw new Error(
              `Message to "${target.label}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`,
            );
          }
          if (effectiveReplyTo) {
            session.tracker.markReplied(effectiveReplyTo);
          }
          return inferredAsk
            ? `Reply sent to ${target.label} (inferred from pending ask)`
            : `Message sent to ${target.label}`;
        }

        case "ask": {
          const to = args.to?.trim();
          const cwd = args.cwd?.trim();
          if (!to && !cwd)
            throw new Error(
              'intercom: "ask" requires a "to" parameter (alias or session id) or a "cwd" scope.',
            );
          const body = requireMessage(args.message, "ask");
          const { session, client } = await requireBroker(selfId, "ask");

          if (session.hasWaiter()) {
            throw new Error(
              "Already waiting for a reply — only one pending ask per session at a time.",
            );
          }
          if (exec.signal?.aborted) {
            throw new Error("Cancelled");
          }

          let target: DeliveryTarget;
          if (cwd) {
            target = await resolveCwdTarget(client, {
              ...(to ? { to } : {}),
              cwd,
            });
          } else {
            const resolved = await resolveSessionTarget(client, to!);
            if (!resolved) {
              throw new Error(
                `Session "${to}" is not currently connected. Blocking asks are not queued; use send for a non-blocking mailbox delivery or retry after the session reconnects.`,
              );
            }
            target = { id: resolved, label: to! };
          }
          if (target.id === client.sessionId) {
            throw new Error("intercom: cannot message the current session.");
          }
          if (exec.signal?.aborted) {
            throw new Error("Cancelled");
          }

          const questionId = randomUUID();
          let deliveryState = "created";
          const replyPromise = session.waitForReply(
            target.id,
            questionId,
            exec.signal,
            () => session.latestDeliveryState(questionId, deliveryState),
          );
          replyPromise.catch(() => undefined);

          try {
            const sendResult = await client.send(target.id, {
              messageId: questionId,
              text: body,
              expectsReply: true,
              ...(args.replyTo ? { replyTo: args.replyTo } : {}),
              ...(args.supersedes ? { supersedes: args.supersedes } : {}),
              ...(args.retryOf ? { retryOf: args.retryOf } : {}),
            });
            deliveryState = sendResult.delivered
              ? "socket_delivered"
              : "delivery_failed";
            if (!sendResult.delivered) {
              const reason =
                sendResult.reason ??
                "Session may not exist or has disconnected.";
              session.rejectReplyWaiter(
                new Error(
                  `Message to "${target.label}" was not delivered: ${reason}`,
                ),
              );
              await replyPromise.catch(() => undefined);
              throw new Error(
                `Message to "${target.label}" was not delivered: ${reason}`,
              );
            }
            const replyMessage = await replyPromise;
            return `**Reply from ${target.label}:**\n${replyMessage.content.text}`;
          } catch (error) {
            session.rejectReplyWaiter(
              error instanceof Error ? error : new Error(String(error)),
            );
            await replyPromise.catch(() => undefined);
            throw error;
          }
        }

        case "reply": {
          const body = requireMessage(args.message, "reply");
          const { session, client } = await requireBroker(selfId, "reply");

          const target = session.tracker.resolveReplyTarget({
            ...(args.to?.trim() ? { to: args.to.trim() } : {}),
            ...(args.replyTo ? { replyTo: args.replyTo } : {}),
          });
          if (target.from.id === client.sessionId) {
            throw new Error("intercom: cannot message the current session.");
          }
          const result = await client.send(target.from.id, {
            text: body,
            replyTo: target.message.id,
          });
          if (!result.delivered) {
            if (result.reason === "Session not found") {
              session.tracker.dismissPendingAsk(target.message.id);
            }
            throw new Error(
              `Reply to "${target.from.name || target.from.id}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`,
            );
          }
          session.tracker.markReplied(target.message.id);
          return `Reply sent to ${target.from.name || target.from.id}`;
        }

        case "pending": {
          const session = deps.broker.sessionFor(selfId);
          const pendingAsks = session?.tracker.listPending() ?? [];
          if (pendingAsks.length === 0) {
            return "No unresolved inbound asks.";
          }
          const now = Date.now();
          const lines = pendingAsks.map(({ from, message, receivedAt }) => {
            const preview = message.content.text
              .replace(/\s+/g, " ")
              .slice(0, 80);
            const elapsedSeconds = Math.max(
              0,
              Math.floor((now - receivedAt) / 1000),
            );
            return `- ${from.name || from.id} · ${message.id} · ${elapsedSeconds}s ago · ${preview}`;
          });
          return `**Pending asks:**\n${lines.join("\n")}`;
        }

        case "cancel": {
          const messageId = args.messageId?.trim();
          if (!messageId) {
            throw new Error(
              'intercom: "cancel" requires a "messageId" parameter.',
            );
          }
          const { client } = await requireBroker(selfId, "cancel");
          const result = await client.cancelMessage(messageId);
          if (!result.delivered) {
            throw new Error(
              `Cancellation for ${messageId} was not delivered: ${result.reason ?? "Message may not exist or may belong to another sender."}`,
            );
          }
          return `Cancellation requested for ${messageId}`;
        }

        case "status": {
          const health = deps.broker.health();
          const lines = [
            `Config: enabled=${deps.config.enabled}, inboundTrigger=${deps.config.inboundTrigger}, replyHint=${deps.config.replyHint ? "on" : "off"}${deps.config.status ? `, status=${JSON.stringify(deps.config.status)}` : ""}`,
          ];
          if (!deps.config.enabled) {
            lines.push("Transport: disabled — no broker connections are made.");
            return lines.join("\n");
          }
          const connected = await connectedClient(selfId);
          if (connected) {
            const roster = await connected.client.listSessions();
            lines.push(
              `Transport: broker (cross-process), ${health.connected}/${health.registered} agent(s) connected`,
              `Session ID: ${connected.client.sessionId}`,
              `Active sessions: ${roster.length}`,
              ...roster.map((session) =>
                brokerRow(
                  session,
                  roster.find(
                    (candidate) => candidate.id === connected.client.sessionId,
                  )?.cwd,
                  session.id === connected.client.sessionId,
                  session.id.slice(0, ID_PREFIX_LENGTH),
                ),
              ),
            );
            return lines.join("\n");
          }
          const sessions = deps.registry.list(selfId);
          lines.push(
            `Transport: local fallback (same-process delivery); broker unavailable${health.errors.length ? `: ${health.errors[0]}` : ""}`,
            `Live sessions in this process: ${sessions.length}.`,
            ...sessions.map((session) =>
              summarizeRow(session, sessions.find((s) => s.self)?.cwd),
            ),
          );
          return lines.join("\n");
        }

        default:
          throw new Error(
            `intercom: unknown action ${JSON.stringify(args.action)}. Supported actions: list, list-cwd, send, ask, reply, pending, status, cancel, name.`,
          );
      }
    },
  });
}
