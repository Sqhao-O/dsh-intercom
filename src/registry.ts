/**
 * In-memory registry of the live agents in this dsh process, plus the intercom
 * alias table. Fed by `agent/created` / `agent/disposed` events (status is read
 * live from the Agent handle, never cached).
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Session } from "@deepseek-ai/dsh-session";
import type { SessionSummary } from "./transport/types.ts";

/** Raised when a name-or-id matches no live session. */
export class UnknownTargetError extends Error {
  constructor(target: string) {
    super(
      `Unknown session ${JSON.stringify(target)}. Run intercom({ action: "list" }) to see live sessions, then address one by alias or session id (a unique id prefix works).`,
    );
    this.name = "UnknownTargetError";
  }
}

/** Raised when an alias or id prefix matches more than one live session. */
export class AmbiguousTargetError extends Error {
  constructor(target: string, matches: readonly SessionSummary[]) {
    const ids = matches.map((match) => match.id).join(", ");
    super(
      `Multiple sessions match ${JSON.stringify(target)} (${ids}). Address one by the id shown in parentheses by "list".`,
    );
    this.name = "AmbiguousTargetError";
  }
}

/** Minimal view of the optional dsh-session-title service (`ctx.sessionTitle`). */
export interface SessionTitleLike {
  rename(session: Session, title: string): unknown;
}

export interface SessionRegistryOptions {
  /**
   * Optional `ctx.sessionTitle` service: aliases are mirrored onto the session
   * title so they show in the dsh UI. Absent (or failing) — aliases live only
   * in this in-memory map.
   */
  readonly sessionTitle?: SessionTitleLike | undefined;
}

export class SessionRegistry {
  private readonly agents = new Map<string, Agent>();
  private readonly aliases = new Map<string, string>();
  private readonly sessionTitle: SessionTitleLike | undefined;

  constructor(options: SessionRegistryOptions = {}) {
    this.sessionTitle = options.sessionTitle;
  }

  /** Track a live agent (idempotent per agent id). */
  add(agent: Agent): void {
    this.agents.set(String(agent.id), agent);
  }

  /** Stop tracking an agent and drop its alias. */
  remove(agent: Agent): void {
    const id = String(agent.id);
    this.agents.delete(id);
    this.aliases.delete(id);
  }

  /** Set the alias of a tracked session; also renames the session title when the service is available. */
  alias(agent: Agent, alias: string): void {
    const name = alias.trim();
    if (!name) throw new Error("Alias must be a non-empty string.");
    this.add(agent);
    this.aliases.set(String(agent.id), name);
    if (this.sessionTitle) {
      try {
        this.sessionTitle.rename(agent.session, name);
      } catch {
        // Title rename is best-effort (the service pins titles on user rename
        // and rejects empty-after-normalize input); the in-memory alias stands.
      }
    }
  }

  /** All tracked sessions as summaries; `selfId` flags the calling session's row. */
  list(selfId?: string): SessionSummary[] {
    return [...this.agents.values()].map((agent) =>
      this.summarize(agent, selfId),
    );
  }

  /** The alias recorded for a session id, if any. */
  aliasOf(sessionId: string): string | undefined {
    return this.aliases.get(sessionId);
  }

  /**
   * Resolve an alias, full session id, or unique id prefix to one live agent.
   * @throws UnknownTargetError / AmbiguousTargetError with actionable messages.
   */
  resolve(nameOrId: string): Agent {
    const target = nameOrId.trim();
    if (!target) throw new UnknownTargetError(nameOrId);

    const lower = target.toLowerCase();
    const aliasMatches = [...this.agents.values()].filter(
      (agent) => this.aliases.get(String(agent.id))?.toLowerCase() === lower,
    );
    if (aliasMatches.length > 1) {
      throw new AmbiguousTargetError(
        target,
        aliasMatches.map((agent) => this.summarize(agent, undefined)),
      );
    }
    if (aliasMatches.length === 1) return aliasMatches[0]!;

    const exact = this.agents.get(target);
    if (exact) return exact;

    const prefixMatches = [...this.agents.values()].filter((agent) =>
      String(agent.id).startsWith(target),
    );
    if (prefixMatches.length > 1) {
      throw new AmbiguousTargetError(
        target,
        prefixMatches.map((agent) => this.summarize(agent, undefined)),
      );
    }
    if (prefixMatches.length === 1) return prefixMatches[0]!;

    throw new UnknownTargetError(target);
  }

  private summarize(agent: Agent, selfId: string | undefined): SessionSummary {
    const id = String(agent.id);
    const provider = agent.options.provider;
    const model = agent.options.model;
    return {
      id,
      alias: this.aliases.get(id),
      cwd: agent.session.header.cwd,
      model: provider && model ? `${provider}/${model}` : (model ?? provider),
      status: agent.status,
      self: selfId !== undefined && id === selfId,
    };
  }
}
