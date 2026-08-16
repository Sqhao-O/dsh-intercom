/**
 * LocalTransport: same-process direct delivery through the live Agent handle.
 * Idle targets get `followup()` (wakes the driver into a new turn); running
 * targets get `steer()` (consumed at the next step boundary). Cross-process
 * delivery is M2's BrokerTransport, behind the same interface.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { formatIntercomMessage } from "../message.ts";
import { INTERCOM_SOURCE_KIND } from "../source.ts";
import type {
  DeliveryResult,
  IntercomMessage,
  SessionSummary,
  Transport,
} from "./types.ts";

/** Summarize the delivery target for the tool result. */
function targetSummary(
  target: Agent,
  alias: string | undefined,
): SessionSummary {
  const provider = target.options.provider;
  const model = target.options.model;
  return {
    id: String(target.id),
    alias,
    cwd: target.session.header.cwd,
    model: provider && model ? `${provider}/${model}` : (model ?? provider),
    status: target.status,
    self: false,
  };
}

export class LocalTransport implements Transport {
  constructor(
    private readonly aliasOf: (sessionId: string) => string | undefined,
  ) {}

  async send(target: Agent, message: IntercomMessage): Promise<DeliveryResult> {
    const text = formatIntercomMessage(
      {
        display: message.from.display,
        address: message.from.address,
        cwd: message.from.cwd,
      },
      message.body,
    );
    const injected = createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: INTERCOM_SOURCE_KIND,
        form: "relay",
        senderSessionId: message.from.sessionId,
      },
    });
    // Verified against @deepseek-ai/dsh-agent@0.1.0-rc.6: followup() queues a
    // new turn and wakes an idle driver; steer() is consumed by a running
    // driver at its next step boundary (and also starts a turn when idle, but
    // followup is the ordinary-message path).
    if (target.status === "idle") {
      target.followup(injected);
      return {
        path: "followup",
        target: targetSummary(target, this.aliasOf(String(target.id))),
      };
    }
    target.steer(injected);
    return {
      path: "steer",
      target: targetSummary(target, this.aliasOf(String(target.id))),
    };
  }
}
