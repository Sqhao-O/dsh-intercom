//#region src/message.ts
/**
* Render the markdown body of an inbound intercom message.
*
* A message that expects a reply gets the `reply`-action hint (when the
* `replyHint` config is on); every other message gets the ordinary `send`
* hint addressed back to the sender's alias or id.
*/
function formatIntercomMessage(sender, body, options = {}) {
	return `${sender.cwd ? `**From ${sender.display}** (${sender.cwd})` : `**From ${sender.display}**`}\n\n${options.expectsReply && (options.replyHint ?? true) ? `To reply, use the intercom tool: intercom({ action: "reply", message: "..." })` : `To reply, use the intercom tool: intercom({ action: "send", to: ${JSON.stringify(sender.address)}, message: "..." })`}\n\n${body}`;
}
/** One row of the `list` action output, shaped like pi-intercom's session list. */
function formatSessionListRow(options) {
	const tags = [options.self ? "self" : options.sameCwd ? "same cwd" : void 0, options.status].filter((tag) => Boolean(tag));
	const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
	return `• ${options.display} (${options.idPrefix}) — ${options.cwd ?? "unknown cwd"} (${options.model ?? "unknown model"})${suffix}`;
}
/** Full `list` action output: the calling session first, then every other live session. */
function formatSessionList(currentRow, otherRows) {
	const sections = [];
	if (currentRow !== void 0) sections.push(`**Current session:**\n${currentRow}`);
	if (otherRows.length > 0) sections.push(`**Other sessions:**\n${otherRows.join("\n")}`);
	if (sections.length === 0) return "No live dsh sessions found in this process.";
	return sections.join("\n\n");
}
/**
* Unique leading id prefixes for a roster (ported from pi-intercom): at least
* 8 chars, extended past any shared prefix, and never cutting through a
* hyphen-separated group.
*/
function sessionIdPrefixes(ids) {
	const prefixes = /* @__PURE__ */ new Map();
	for (const id of ids) {
		let longestSharedPrefix = 0;
		for (const other of ids) {
			if (other === id) continue;
			let length = 0;
			while (length < id.length && id[length] === other[length]) length += 1;
			longestSharedPrefix = Math.max(longestSharedPrefix, length);
		}
		const minimumLength = Math.max(8, longestSharedPrefix + 1);
		const groupBoundary = id.indexOf("-", minimumLength);
		const length = groupBoundary === -1 ? minimumLength : groupBoundary;
		prefixes.set(id, id.slice(0, length));
	}
	return prefixes;
}
//#endregion
export { formatIntercomMessage, formatSessionList, formatSessionListRow, sessionIdPrefixes };
