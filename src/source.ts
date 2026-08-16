/**
 * Intercom message source: merge-extends the dsh-llm `MessageSourceMap` with a
 * dedicated `intercom` kind so injected relay messages are identifiable in the
 * durable session log (and render as relays in the web UI, which understands
 * `form: 'relay'`).
 *
 * Verified against `@deepseek-ai/dsh-llm@0.1.0-rc.6` (`lib/types/message.d.ts`):
 * `ContextFormed` requires no extra fields for `form: 'relay'`; the map is a
 * plain interface so plugins may add their own kinds.
 */
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    intercom: {
      kind: "intercom";
      /** A message another agent addressed to this one. */
      form: "relay";
      /** Session id of the agent that sent the message. */
      senderSessionId: string;
    };
  }
}

/** The `MessageSource.kind` this plugin stamps on relayed messages. */
export const INTERCOM_SOURCE_KIND = "intercom" as const;
