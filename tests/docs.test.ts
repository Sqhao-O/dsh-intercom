/**
 * Docs-as-tests: every runnable shell command in the READMEs must have real
 * execution coverage. Only ```bash fenced blocks in README.md and
 * README.zh-CN.md are checked (tool-call examples, JSON config samples, and
 * the not-yet-available `github:` install placeholder are not shell blocks).
 *
 * A command is covered when EITHER
 *   (a) it is a pnpm script/builtin that the acceptance gate runs
 *       (pnpm install/build/test/lint/typecheck/format/pack — the gate in
 *       CONTRIBUTING.md executes them), or
 *   (b) it is a dsh CLI invocation whose exact shape is executed by an e2e
 *       script under tests/e2e/ against a scratch DSH_HOME (cross-checked by
 *       string match against those sources), or
 *   (c) it is explicitly listed in ILLUSTRATIVE below with a reason.
 *
 * An unmatched command fails this test — extend the e2e coverage or justify
 * the exception here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoDir = process.cwd();
const README_FILES = ["README.md", "README.zh-CN.md"];
const E2E_SOURCES = [
  "tests/e2e/run.ts",
  "tests/e2e/runner-plugin.mjs",
  "tests/e2e/install-preview.ts",
  "tests/e2e/install-check.mjs",
  "tests/e2e/panel.ts",
  "tests/e2e/panel-probe.mjs",
  "tests/e2e/dod-install.ts",
  "tests/e2e/dod-runner.mjs",
].map((file) => readFileSync(join(repoDir, file), "utf8"));

/** pnpm subcommands that need no package.json script entry. */
const PNPM_BUILTINS = new Set(["install", "pack", "exec"]);

/**
 * Commands that are intentionally NOT executed anywhere, each with the
 * reason. Keep this list empty unless the command genuinely cannot run in
 * automation.
 */
const ILLUSTRATIVE: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^dsh web$/,
    reason:
      "boots a long-running interactive server; the headless boot is covered by tests/e2e/run.ts and install-preview.ts",
  },
];

const packageJson = JSON.parse(
  readFileSync(join(repoDir, "package.json"), "utf8"),
) as { scripts: Record<string, string> };

/** Extract the command lines of every ```bash fenced block. */
function bashCommands(file: string): string[] {
  const content = readFileSync(join(repoDir, file), "utf8");
  const commands: string[] = [];
  const fence = /```bash\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content))) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        commands.push(trimmed);
      }
    }
  }
  return commands;
}

/** Split `a && b | c` into its simple command segments (comments stripped). */
function segments(command: string): string[] {
  return command
    .replace(/\s+#.*$/, "")
    .split(/&&|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function e2eCovers(...needles: string[]): boolean {
  return needles.every((needle) =>
    E2E_SOURCES.some((source) => source.includes(needle)),
  );
}

function assertCovered(file: string, segment: string): void {
  const label = `${file}: \`${segment}\``;

  const pnpm = /^pnpm (\S+)/.exec(segment);
  if (pnpm) {
    const sub = pnpm[1]!;
    assert.ok(
      PNPM_BUILTINS.has(sub) || sub in packageJson.scripts,
      `${label} — pnpm subcommand "${sub}" is neither a builtin nor a package.json script`,
    );
    return;
  }

  if (segment.startsWith("export DSH_HOME=")) {
    assert.ok(
      e2eCovers("DSH_HOME"),
      `${label} — e2e scripts must run dsh with a scratch DSH_HOME`,
    );
    return;
  }

  if (segment.startsWith("dsh plugin --profile web add link:")) {
    assert.ok(
      e2eCovers('"plugin", "--profile", "web", "add"', "link:"),
      `${label} — no e2e script runs dsh plugin --profile web add link:`,
    );
    return;
  }

  if (segment.startsWith("dsh plugin --profile web add ")) {
    assert.ok(
      e2eCovers('"plugin", "--profile", "web", "add"', "packTarball"),
      `${label} — no e2e script installs a packed tarball into the web profile`,
    );
    return;
  }

  if (segment.startsWith("dsh --profile web --dump-config")) {
    assert.ok(
      e2eCovers('"--profile", "web", "--dump-config"'),
      `${label} — no e2e script runs dsh --profile web --dump-config`,
    );
    return;
  }

  if (segment.startsWith("grep ")) {
    // The grep half of `dsh ... --dump-config | grep dsh-intercom`: covered
    // when an e2e script asserts the composed config contains the plugin id.
    assert.ok(
      e2eCovers('dump.includes("dsh-intercom")'),
      `${label} — no e2e script greps the dump-config output for dsh-intercom`,
    );
    return;
  }

  const illustrative = ILLUSTRATIVE.find((entry) =>
    entry.pattern.test(segment),
  );
  assert.ok(
    illustrative,
    `${label} — no execution coverage found and no ILLUSTRATIVE entry; extend tests/e2e or justify the exception in tests/docs.test.ts`,
  );
}

for (const file of README_FILES) {
  test(`${file}: every runnable bash command is executed or justified`, () => {
    const commands = bashCommands(file);
    assert.ok(commands.length > 0, `${file} has no bash blocks to check`);
    for (const command of commands) {
      for (const segment of segments(command)) {
        assertCovered(file, segment);
      }
    }
  });
}

test("the ILLUSTRATIVE allowlist stays honest", () => {
  for (const entry of ILLUSTRATIVE) {
    assert.ok(
      README_FILES.some((file) =>
        bashCommands(file).some((command) =>
          segments(command).some((segment) => entry.pattern.test(segment)),
        ),
      ),
      `ILLUSTRATIVE entry ${entry.pattern} no longer matches any README command — remove it`,
    );
  }
});
