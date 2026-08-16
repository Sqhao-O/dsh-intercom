/**
 * Pure formatting for intercom payloads injected into a target session.
 * Mirrors pi-intercom's inbound message shape (`**From <alias>** (<cwd>)` plus
 * a reply hint), adapted to the send-only M1 action set.
 */

/** Sender identity rendered into the injected message header. */
export interface IntercomSender {
  /** Alias if the sender set one, otherwise a short id prefix. */
  readonly display: string;
  /** Value the recipient should pass as `to` when replying. */
  readonly address: string;
  readonly cwd: string | undefined;
}

/**
 * Render the markdown body of an inbound intercom message.
 *
 * The reply hint deliberately references `send` (not `reply`): blocking
 * ask/reply is M2; for M1 the addressed session answers with an ordinary send
 * back to the sender's alias or id.
 */
export function formatIntercomMessage(
  sender: IntercomSender,
  body: string,
): string {
  const origin = sender.cwd
    ? `**From ${sender.display}** (${sender.cwd})`
    : `**From ${sender.display}**`;
  const hint = `To reply, use the intercom tool: intercom({ action: "send", to: ${JSON.stringify(
    sender.address,
  )}, message: "..." })`;
  return `${origin}\n\n${hint}\n\n${body}`;
}

/** One row of the `list` action output, shaped like pi-intercom's session list. */
export function formatSessionListRow(options: {
  readonly display: string;
  readonly idPrefix: string;
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly status: string;
  readonly self: boolean;
  readonly sameCwd: boolean;
}): string {
  const tags = [
    options.self ? "self" : options.sameCwd ? "same cwd" : undefined,
    options.status,
  ].filter((tag): tag is string => Boolean(tag));
  const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
  return `• ${options.display} (${options.idPrefix}) — ${options.cwd ?? "unknown cwd"} (${options.model ?? "unknown model"})${suffix}`;
}

/** Full `list` action output: the calling session first, then every other live session. */
export function formatSessionList(
  currentRow: string | undefined,
  otherRows: readonly string[],
): string {
  const sections: string[] = [];
  if (currentRow !== undefined)
    sections.push(`**Current session:**\n${currentRow}`);
  if (otherRows.length > 0)
    sections.push(`**Other sessions:**\n${otherRows.join("\n")}`);
  if (sections.length === 0)
    return "No live dsh sessions found in this process.";
  return sections.join("\n\n");
}
