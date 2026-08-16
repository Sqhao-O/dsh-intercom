/**
 * Transport layer types. The tool layer talks only to this interface; M2 adds
 * a `BrokerTransport` (cross-process socket broker) implementing the same
 * contract without touching the tool.
 */
import type { Agent } from "@deepseek-ai/dsh-agent";

/** One live session as reported by the `list` action. */
export interface SessionSummary {
  /** Full session id. */
  readonly id: string;
  /** Intercom alias, when one was set. */
  readonly alias: string | undefined;
  readonly cwd: string | undefined;
  /** `<provider>/<model>` when both are known. */
  readonly model: string | undefined;
  readonly status: "idle" | "running";
  /** Whether this row is the calling session. */
  readonly self: boolean;
}

/** An outbound intercom message with its sender identity already resolved. */
export interface IntercomMessage {
  readonly from: {
    readonly sessionId: string;
    readonly display: string;
    readonly address: string;
    readonly cwd: string | undefined;
  };
  readonly body: string;
}

/** How a message entered the target session. */
export type DeliveryPath = "followup" | "steer";

/** Outcome of one delivery attempt. */
export interface DeliveryResult {
  readonly path: DeliveryPath;
  readonly target: SessionSummary;
}

/**
 * Message delivery to a resolved target agent. Implementations must not throw
 * for an absent target — resolution happens above this layer — but may throw
 * when the target disappears mid-delivery.
 */
export interface Transport {
  send(target: Agent, message: IntercomMessage): Promise<DeliveryResult>;
}
