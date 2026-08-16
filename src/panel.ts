/**
 * Web UI panel, host side: the HTTP routes the browser half (`client.js`)
 * talks to. Mounted only when the profile provides the `webServer` service
 * (the web host); headless profiles skip the panel entirely.
 *
 * Routes (registered as the `/intercom` prefix):
 *   GET  /intercom/roster → `{ enabled, transport, sessions, senders }`
 *   POST /intercom/send   `{ from, to, message }` → `{ delivered, reason? }`
 *
 * The panel never invents a sender identity: `from` must name a session whose
 * agent lives in THIS host process, and the message rides that session's own
 * broker client — the receiver sees the real session as the sender, exactly
 * as if that session had run intercom({ action: "send" }) itself.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type { IntercomConfig } from "./config.ts";
import type { SessionRegistry } from "./registry.ts";
import type { BrokerTransport } from "./transport/broker.ts";

/** Structural view of the dsh-host-webserver service (optional dependency). */
interface WebServerLike {
  register(route: {
    kind: "exact" | "prefix";
    path: string;
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
    ) => void | Promise<void>;
  }): () => void;
}

export interface PanelDeps {
  readonly registry: SessionRegistry;
  readonly broker: BrokerTransport;
  readonly config: IntercomConfig;
}

interface PanelSessionRow {
  id: string;
  prefix: string;
  name: string | null;
  cwd?: string;
  model?: string;
  status: string;
  /** True when the session's agent lives in this host process. */
  local: boolean;
}

const ID_PREFIX_LENGTH = 8;
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * The roster payload: the broker's cross-process session list when any local
 * agent is connected, otherwise this process's in-memory registry. `senders`
 * are the local sessions the panel may send from.
 */
async function rosterPayload(deps: PanelDeps): Promise<unknown> {
  if (!deps.config.enabled) {
    return { enabled: false, transport: "disabled", sessions: [], senders: [] };
  }
  const attached = deps.broker.listAttached();
  const localIds = new Set(attached.map((session) => session.agentId));
  // Prefer an already-connected client; otherwise actively connect the first
  // attached session (concurrent callers share the in-flight attempt and
  // failures ride the internal reconnect backoff) so the panel's first poll
  // does not report an empty local roster while the broker is still coming up.
  const candidate =
    attached.find((session) => session.isConnected()) ?? attached[0];
  if (candidate) {
    try {
      const client = await candidate.ensureConnected();
      const sessions = await client.listSessions();
      const rows: PanelSessionRow[] = sessions.map((session) => ({
        id: session.id,
        prefix: session.id.slice(0, ID_PREFIX_LENGTH),
        name: session.name ?? null,
        ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
        ...(session.model !== undefined ? { model: session.model } : {}),
        status: session.status ?? "unknown",
        local: localIds.has(session.id),
      }));
      return {
        enabled: true,
        transport: "broker",
        sessions: rows,
        senders: rows
          .filter((row) => row.local)
          .map((row) => ({ id: row.id, name: row.name })),
      };
    } catch {
      // Broker unreachable — fall through to the local-process roster.
    }
  }
  // No broker connection yet (or broker unavailable): report what this
  // process knows directly so the panel still shows local sessions.
  const rows: PanelSessionRow[] = attached.map((session) => {
    const summary = deps.registry.list(session.agentId).find((s) => s.self);
    return {
      id: session.agentId,
      prefix: session.agentId.slice(0, ID_PREFIX_LENGTH),
      name: summary?.alias ?? null,
      ...(summary?.cwd !== undefined ? { cwd: summary.cwd } : {}),
      ...(summary?.model !== undefined ? { model: summary.model } : {}),
      status: summary?.status ?? "unknown",
      local: true,
    };
  });
  return {
    enabled: true,
    transport: "local",
    sessions: rows,
    senders: rows.map((row) => ({ id: row.id, name: row.name })),
  };
}

async function sendPayload(
  deps: PanelDeps,
  body: Record<string, unknown>,
): Promise<{ status: number; value: unknown }> {
  const { from, to, message } = body;
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof message !== "string" ||
    !from.trim() ||
    !to.trim() ||
    !message.trim()
  ) {
    return {
      status: 400,
      value: { error: 'send requires non-empty "from", "to", and "message".' },
    };
  }
  if (!deps.config.enabled) {
    return { status: 409, value: { error: "dsh-intercom is disabled." } };
  }
  const session = deps.broker.sessionFor(from);
  if (!session) {
    return {
      status: 400,
      value: {
        error:
          '"from" must be a session hosted by this dsh process (see the "senders" list).',
      },
    };
  }
  if (from === to) {
    return {
      status: 400,
      value: { error: "cannot message the sender itself." },
    };
  }
  const client = await session.ensureConnected();
  const result = await client.send(to, { text: message });
  if (!result.delivered) {
    return {
      status: 502,
      value: {
        delivered: false,
        reason: result.reason ?? "Session may not exist or has disconnected.",
      },
    };
  }
  return { status: 200, value: { delivered: true } };
}

/**
 * Register the panel routes once the web server service is up. `ctx.inject`
 * defers the callback until `webServer` activates (our own inject list —
 * agents/tools — resolves earlier in web profile startup), and never runs it
 * in profiles without a web server (headless, minimal).
 */
export function registerPanelRoutes(ctx: Context, deps: PanelDeps): void {
  (
    ctx.inject as (
      deps: readonly string[],
      callback: (ctx: Context) => void,
    ) => unknown
  )(["webServer"], (webCtx) => {
    const webServer = webCtx.get("webServer") as WebServerLike | undefined;
    if (!webServer) {
      return;
    }
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
            const body = await readJsonBody(req);
            const { status, value } = await sendPayload(deps, body);
            sendJson(res, status, value);
            return;
          }
          sendJson(res, 404, { error: "unknown intercom panel endpoint" });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
  });
}
