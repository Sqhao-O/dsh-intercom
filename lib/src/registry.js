//#region src/registry.ts
/** Raised when a name-or-id matches no live session. */
var UnknownTargetError = class extends Error {
	constructor(target) {
		super(`Unknown session ${JSON.stringify(target)}. Run intercom({ action: "list" }) to see live sessions, then address one by alias or session id (a unique id prefix works).`);
		this.name = "UnknownTargetError";
	}
};
/** Raised when an alias or id prefix matches more than one live session. */
var AmbiguousTargetError = class extends Error {
	constructor(target, matches) {
		const ids = matches.map((match) => match.id).join(", ");
		super(`Multiple sessions match ${JSON.stringify(target)} (${ids}). Address one by the id shown in parentheses by "list".`);
		this.name = "AmbiguousTargetError";
	}
};
var SessionRegistry = class {
	agents = /* @__PURE__ */ new Map();
	aliases = /* @__PURE__ */ new Map();
	sessionTitle;
	constructor(options = {}) {
		this.sessionTitle = options.sessionTitle;
	}
	/** Track a live agent (idempotent per agent id). */
	add(agent) {
		this.agents.set(String(agent.id), agent);
	}
	/** Stop tracking an agent and drop its alias. */
	remove(agent) {
		const id = String(agent.id);
		this.agents.delete(id);
		this.aliases.delete(id);
	}
	/** Set the alias of a tracked session; also renames the session title when the service is available. */
	alias(agent, alias) {
		const name = alias.trim();
		if (!name) throw new Error("Alias must be a non-empty string.");
		this.add(agent);
		this.aliases.set(String(agent.id), name);
		if (this.sessionTitle) try {
			this.sessionTitle.rename(agent.session, name);
		} catch {}
	}
	/** All tracked sessions as summaries; `selfId` flags the calling session's row. */
	list(selfId) {
		return [...this.agents.values()].map((agent) => this.summarize(agent, selfId));
	}
	/** The alias recorded for a session id, if any. */
	aliasOf(sessionId) {
		return this.aliases.get(sessionId);
	}
	/**
	* Resolve an alias, full session id, or unique id prefix to one live agent.
	* @throws UnknownTargetError / AmbiguousTargetError with actionable messages.
	*/
	resolve(nameOrId) {
		const target = nameOrId.trim();
		if (!target) throw new UnknownTargetError(nameOrId);
		const lower = target.toLowerCase();
		const aliasMatches = [...this.agents.values()].filter((agent) => this.aliases.get(String(agent.id))?.toLowerCase() === lower);
		if (aliasMatches.length > 1) throw new AmbiguousTargetError(target, aliasMatches.map((agent) => this.summarize(agent, void 0)));
		if (aliasMatches.length === 1) return aliasMatches[0];
		const exact = this.agents.get(target);
		if (exact) return exact;
		const prefixMatches = [...this.agents.values()].filter((agent) => String(agent.id).startsWith(target));
		if (prefixMatches.length > 1) throw new AmbiguousTargetError(target, prefixMatches.map((agent) => this.summarize(agent, void 0)));
		if (prefixMatches.length === 1) return prefixMatches[0];
		throw new UnknownTargetError(target);
	}
	summarize(agent, selfId) {
		const id = String(agent.id);
		const provider = agent.options.provider;
		const model = agent.options.model;
		return {
			id,
			alias: this.aliases.get(id),
			cwd: agent.session.header.cwd,
			model: provider && model ? `${provider}/${model}` : model ?? provider,
			status: agent.status,
			self: selfId !== void 0 && id === selfId
		};
	}
};
//#endregion
export { AmbiguousTargetError, SessionRegistry, UnknownTargetError };
