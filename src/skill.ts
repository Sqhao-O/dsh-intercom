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
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";

/** src/skill.ts → repo root, lib/src/skill.js → package root: `../../`. */
const SKILL_FILE = fileURLToPath(
  new URL("../../skills/dsh-intercom/SKILL.md", import.meta.url),
);

/** Structural view of the dsh-skill registry (avoids a hard dependency). */
interface SkillRegistryLike {
  register(skill: {
    name: string;
    description: string;
    source: string;
    resourceBase: { kind: "directory"; path: string };
    path?: string;
    content: string;
  }): () => void;
}

interface ParsedSkill {
  name: string;
  description: string;
  content: string;
}

/**
 * Parse the two frontmatter fields we need (name, description) plus the body.
 * Handles plain scalars and `|`/`>-` block scalars; anything else fails the
 * registration with a warning rather than breaking plugin load.
 */
function parseSkillFile(raw: string): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("missing YAML frontmatter");
  const [, frontmatter, body] = match as unknown as [string, string, string];
  const fields: Record<string, string> = {};
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const field = /^(\w[\w-]*):\s*(.*)$/.exec(lines[index]!);
    if (!field) continue;
    const [, key, value] = field as unknown as [string, string, string];
    if (value === "|" || value === "|-" || value === ">" || value === ">-") {
      const block: string[] = [];
      while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1]!)) {
        index += 1;
        block.push(lines[index]!.trim());
      }
      fields[key!] = value.startsWith(">") ? block.join(" ") : block.join("\n");
    } else {
      fields[key!] = value;
    }
  }
  const name = fields["name"]?.trim();
  const description = fields["description"]?.replace(/\s+/g, " ").trim();
  if (!name || !description) {
    throw new Error("frontmatter requires name and description");
  }
  return { name, description, content: body.trim() };
}

/** Register the bundled SKILL.md as a runtime skill; never throws. */
export function registerBundledSkill(ctx: Context): void {
  const skills = ctx.get("skills") as SkillRegistryLike | undefined;
  if (!skills) return;
  try {
    const parsed = parseSkillFile(readFileSync(SKILL_FILE, "utf8"));
    skills.register({
      name: parsed.name,
      description: parsed.description,
      source: "bundled",
      resourceBase: { kind: "directory", path: dirname(SKILL_FILE) },
      path: SKILL_FILE,
      content: parsed.content,
    });
  } catch (error) {
    ctx.logger.warn(
      `dsh-intercom: bundled skill not registered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
