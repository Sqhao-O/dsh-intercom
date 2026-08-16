//#region src/message.ts
/**
* Render the markdown body of an inbound intercom message.
*
* The reply hint deliberately references `send` (not `reply`): blocking
* ask/reply is M2; for M1 the addressed session answers with an ordinary send
* back to the sender's alias or id.
*/
function formatIntercomMessage(sender, body) {
	return `${sender.cwd ? `**From ${sender.display}** (${sender.cwd})` : `**From ${sender.display}**`}\n\n${`To reply, use the intercom tool: intercom({ action: "send", to: ${JSON.stringify(sender.address)}, message: "..." })`}\n\n${body}`;
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
//#endregion
export { formatIntercomMessage, formatSessionList, formatSessionListRow };
