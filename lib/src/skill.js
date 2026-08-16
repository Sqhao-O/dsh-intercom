import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/skill.ts
/**
* Bundled skill registration. dsh rc.6 has no plugin-shipped skill discovery
* (the filesystem provider scans project/user roots only), so the plugin reads
* its packaged `skills/dsh-intercom/SKILL.md` and registers it as a runtime
* skill through `ctx.skills.register()`: installing the plugin is enough to
* make the coordination playbook discoverable — no manual copy step.
*
* The registry service is optional: a minimal profile without `dsh-skill`
* simply skips registration (the intercom tool is unaffected).
*/
/** src/skill.ts → repo root, lib/src/skill.js → package root: `../../`. */
const SKILL_FILE = fileURLToPath(new URL("../../skills/dsh-intercom/SKILL.md", import.meta.url));
/**
* Parse the two frontmatter fields we need (name, description) plus the body.
* Handles plain scalars and `|`/`>-` block scalars; anything else fails the
* registration with a warning rather than breaking plugin load.
*/
function parseSkillFile(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) throw new Error("missing YAML frontmatter");
	const [, frontmatter, body] = match;
	const fields = {};
	const lines = frontmatter.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const field = /^(\w[\w-]*):\s*(.*)$/.exec(lines[index]);
		if (!field) continue;
		const [, key, value] = field;
		if (value === "|" || value === "|-" || value === ">" || value === ">-") {
			const block = [];
			while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1])) {
				index += 1;
				block.push(lines[index].trim());
			}
			fields[key] = value.startsWith(">") ? block.join(" ") : block.join("\n");
		} else fields[key] = value;
	}
	const name = fields["name"]?.trim();
	const description = fields["description"]?.replace(/\s+/g, " ").trim();
	if (!name || !description) throw new Error("frontmatter requires name and description");
	return {
		name,
		description,
		content: body.trim()
	};
}
/** Register the bundled SKILL.md as a runtime skill; never throws. */
function registerBundledSkill(ctx) {
	const skills = ctx.get("skills");
	if (!skills) return;
	try {
		const parsed = parseSkillFile(readFileSync(SKILL_FILE, "utf8"));
		skills.register({
			name: parsed.name,
			description: parsed.description,
			source: "bundled",
			resourceBase: {
				kind: "directory",
				path: dirname(SKILL_FILE)
			},
			path: SKILL_FILE,
			content: parsed.content
		});
	} catch (error) {
		ctx.logger.warn(`dsh-intercom: bundled skill not registered: ${error instanceof Error ? error.message : String(error)}`);
	}
}
//#endregion
export { registerBundledSkill };
