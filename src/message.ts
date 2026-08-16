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

/** Options shaping the reply hint of an inbound message. */
export interface InboundFormatOptions {
  /** The sender asked for a reply (blocking `ask`). */
  readonly expectsReply?: boolean;
  /** Config `replyHint` (default true): show the `reply` action for asks. */
  readonly replyHint?: boolean;
}

/**
 * Render the markdown body of an inbound intercom message.
 *
 * A message that expects a reply gets the `reply`-action hint (when the
 * `replyHint` config is on); every other message gets the ordinary `send`
 * hint addressed back to the sender's alias or id.
 */
export function formatIntercomMessage(
  sender: IntercomSender,
  body: string,
  options: InboundFormatOptions = {},
): string {
  const origin = sender.cwd
    ? `**From ${sender.display}** (${sender.cwd})`
    : `**From ${sender.display}**`;
  const replyHint = options.expectsReply && (options.replyHint ?? true);
  const hint = replyHint
    ? `To reply, use the intercom tool: intercom({ action: "reply", message: "..." })`
    : `To reply, use the intercom tool: intercom({ action: "send", to: ${JSON.stringify(
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

/**
 * Unique leading id prefixes for a roster (ported from pi-intercom): at least
 * 8 chars, extended past any shared prefix, and never cutting through a
 * hyphen-separated group.
 */
export function sessionIdPrefixes(ids: readonly string[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const id of ids) {
    let longestSharedPrefix = 0;
    for (const other of ids) {
      if (other === id) {
        continue;
      }
      let length = 0;
      while (length < id.length && id[length] === other[length]) {
        length += 1;
      }
      longestSharedPrefix = Math.max(longestSharedPrefix, length);
    }
    const minimumLength = Math.max(8, longestSharedPrefix + 1);
    const groupBoundary = id.indexOf("-", minimumLength);
    const length = groupBoundary === -1 ? minimumLength : groupBoundary;
    prefixes.set(id, id.slice(0, length));
  }
  return prefixes;
}
