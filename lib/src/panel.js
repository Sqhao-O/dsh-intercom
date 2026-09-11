//#region src/panel.ts
const ID_PREFIX_LENGTH = 8;
const MAX_BODY_BYTES = 64 * 1024;
function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	const parsed = text.length > 0 ? JSON.parse(text) : {};
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
	return parsed;
}
/**
* The roster payload: the broker's cross-process session list when any local
* agent is connected, otherwise this process's in-memory registry. `senders`
* are the local sessions the panel may send from.
*/
async function rosterPayload(deps) {
	if (!deps.config.enabled) return {
		enabled: false,
		transport: "disabled",
		sessions: [],
		senders: []
	};
	const attached = deps.broker.listAttached();
	const localIds = new Set(attached.map((session) => session.agentId));
	const candidate = attached.find((session) => session.isConnected()) ?? attached[0];
	if (candidate) try {
		const rows = (await (await candidate.ensureConnected()).listSessions()).map((session) => ({
			id: session.id,
			prefix: session.id.slice(0, ID_PREFIX_LENGTH),
			name: session.name ?? null,
			...session.cwd !== void 0 ? { cwd: session.cwd } : {},
			...session.model !== void 0 ? { model: session.model } : {},
			status: session.status ?? "unknown",
			local: localIds.has(session.id)
		}));
		return {
			enabled: true,
			transport: "broker",
			sessions: rows,
			senders: rows.filter((row) => row.local).map((row) => ({
				id: row.id,
				name: row.name
			}))
		};
	} catch {}
	const rows = attached.map((session) => {
		const summary = deps.registry.list(session.agentId).find((s) => s.self);
		return {
			id: session.agentId,
			prefix: session.agentId.slice(0, ID_PREFIX_LENGTH),
			name: summary?.alias ?? null,
			...summary?.cwd !== void 0 ? { cwd: summary.cwd } : {},
			...summary?.model !== void 0 ? { model: summary.model } : {},
			status: summary?.status ?? "unknown",
			local: true
		};
	});
	return {
		enabled: true,
		transport: "local",
		sessions: rows,
		senders: rows.map((row) => ({
			id: row.id,
			name: row.name
		}))
	};
}
async function sendPayload(deps, body) {
	const { from, to, message } = body;
	if (typeof from !== "string" || typeof to !== "string" || typeof message !== "string" || !from.trim() || !to.trim() || !message.trim()) return {
		status: 400,
		value: { error: "send requires non-empty \"from\", \"to\", and \"message\"." }
	};
	if (!deps.config.enabled) return {
		status: 409,
		value: { error: "dsh-intercom is disabled." }
	};
	const session = deps.broker.sessionFor(from);
	if (!session) return {
		status: 400,
		value: { error: "\"from\" must be a session hosted by this dsh process (see the \"senders\" list)." }
	};
	if (from === to) return {
		status: 400,
		value: { error: "cannot message the sender itself." }
	};
	const result = await (await session.ensureConnected()).send(to, { text: message });
	if (!result.delivered) return {
		status: 502,
		value: {
			delivered: false,
			reason: result.reason ?? "Session may not exist or has disconnected."
		}
	};
	return {
		status: 200,
		value: { delivered: true }
	};
}
/**
* Register the panel routes once the web server service is up. `ctx.inject`
* defers the callback until `webServer` activates (our own inject list —
* agents/tools — resolves earlier in web profile startup), and never runs it
* in profiles without a web server (headless, minimal).
*/
function registerPanelRoutes(ctx, deps) {
	ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.get("webServer");
		if (!webServer) return;
		webServer.register({
			kind: "prefix",
			path: "/intercom",
			handler: async (req, res) => {
				try {
					const path = new URL(req.url ?? "/", "http://localhost").pathname;
					if (path === "/intercom/roster" && req.method === "GET") {
						sendJson(res, 200, await rosterPayload(deps));
						return;
					}
					if (path === "/intercom/send" && req.method === "POST") {
						const { status, value } = await sendPayload(deps, await readJsonBody(req));
						sendJson(res, status, value);
						return;
					}
					sendJson(res, 404, { error: "unknown intercom panel endpoint" });
				} catch (error) {
					sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		});
	});
}
//#endregion
export { registerPanelRoutes };
