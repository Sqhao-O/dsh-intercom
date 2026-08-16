/**
 * Install preview (`pnpm test:install`). Not part of `pnpm test`: it packs the
 * repo, inspects the tarball, and installs it into a scratch DSH_HOME with the
 * real dsh CLI — the local equivalent of `dsh plugin add github:<owner>/dsh-intercom`
 * (which needs the public repo; lib/ is committed, so no build runs at install
 * time in either flow). The real ~/.dsh is never touched: every dsh invocation
 * gets a scratch DSH_HOME under the OS temp dir.
 *
 * README commands this script executes (tests/docs.test.ts cross-checks that
 * every runnable README command appears here or in another executed script):
 *   pnpm build
 *   pnpm pack --pack-destination <dir>
 *   dsh plugin --profile web add link:<checkout>
 *   dsh plugin --profile web add <tarball>
 *   dsh --profile web --dump-config | grep dsh-intercom
 *
 * Windows-safe: pnpm is a .cmd shim (spawned through the shell); the dsh bin is
 * resolved from `npm root -g` (or $DSH_BIN) and run through process.execPath.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(E2E_DIR, "..", "..");
const CLI_TIMEOUT_MS = 120_000;

const out = (line: string) => process.stdout.write(`[install] ${line}\n`);

function resolveDshBin(): string {
  if (process.env.DSH_BIN) return process.env.DSH_BIN;
  // npm is a .cmd shim on Windows; route through the shell so it resolves.
  const globalRoot = execFileSync("npm root -g", {
    encoding: "utf8",
    shell: true,
  }).trim();
  return join(globalRoot, "@deepseek-ai", "dsh", "lib", "bin.js");
}

/** Run the dsh CLI with a scratch DSH_HOME; returns exit code + output. */
function runDsh(
  bin: string,
  args: string[],
  dshHome: string,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const proc = spawn(process.execPath, [bin, ...args], {
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DEEPSEEK_API_KEY: "install-preview-mock-key",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: string[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
    proc.stderr.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
    const killer = setTimeout(() => {
      proc.kill();
      resolvePromise({
        code: null,
        output: `${chunks.join("")}\n[timed out after ${CLI_TIMEOUT_MS}ms]`,
      });
    }, CLI_TIMEOUT_MS);
    proc.on("exit", (code) => {
      clearTimeout(killer);
      resolvePromise({ code, output: chunks.join("") });
    });
  });
}

async function mustRunDsh(
  bin: string,
  args: string[],
  dshHome: string,
): Promise<string> {
  const result = await runDsh(bin, args, dshHome);
  assert.equal(
    result.code,
    0,
    `dsh ${args.join(" ")} failed:\n${result.output}`,
  );
  return result.output;
}

/** pnpm pack into `packDir`; returns the absolute tarball path. */
function packTarball(packDir: string): string {
  const output = execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: true,
  });
  const lastLine = output.trim().split(/\r?\n/).at(-1)!.trim();
  const tarball = isAbsolute(lastLine) ? lastLine : join(packDir, lastLine);
  assert.ok(existsSync(tarball), `pnpm pack produced no tarball at ${tarball}`);
  return tarball;
}

function inspectTarball(tarball: string): void {
  // --force-local: GNU tar would otherwise treat the "C:" drive prefix as a
  // remote host and pipe the archive through rsh.
  const entries = execFileSync("tar", ["--force-local", "-tzf", tarball], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const has = (suffix: string) =>
    entries.some((entry) => entry === `package/${suffix}`);
  for (const required of [
    "lib/src/index.js",
    "lib/broker/broker.js",
    "client.js",
    "skills/dsh-intercom/SKILL.md",
    "cordis.patch.yml",
    "package.json",
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
    "NOTICE",
  ]) {
    assert.ok(has(required), `tarball is missing package/${required}`);
  }
  for (const forbidden of ["src/", "tests/", "reference/"]) {
    assert.ok(
      !entries.some((entry) => entry.startsWith(`package/${forbidden}`)),
      `tarball must not contain ${forbidden}`,
    );
  }
  out(
    `tarball ok: ${entries.length} entries, lib/ + NOTICE present, no sources`,
  );
}

async function main(): Promise<void> {
  assert.ok(
    existsSync(join(REPO_ROOT, "lib", "src", "index.js")) &&
      existsSync(join(REPO_ROOT, "lib", "broker", "broker.js")),
    "lib/ is missing — run `pnpm build` first",
  );

  const workDir = await mkdtemp(join(tmpdir(), "dsh-intercom-install-"));
  try {
    // 1. Pack and inspect the tarball (what `dsh plugin add github:` will get).
    const packDir = join(workDir, "pack");
    await mkdir(packDir, { recursive: true });
    const tarball = packTarball(packDir);
    inspectTarball(tarball);

    const bin = resolveDshBin();

    // 2. Tarball install into the web profile + the composed-config check —
    //    the exact commands from the README "Install from tarball" section.
    const tarballHome = join(workDir, "home-tarball");
    await mkdir(tarballHome, { recursive: true });
    await mustRunDsh(
      bin,
      ["plugin", "--profile", "web", "add", tarball],
      tarballHome,
    );
    out("tarball installed into the web profile");
    const dump = await mustRunDsh(
      bin,
      ["--profile", "web", "--dump-config"],
      tarballHome,
    );
    assert.ok(
      dump.includes("dsh-intercom"),
      "dump-config does not list dsh-intercom",
    );
    out("dump-config lists the dsh-intercom row");

    // 3. The installed module must actually LOAD: install the tarball into the
    //    headless profile as well and boot it with the checker plugin (no LLM
    //    call — the checker only probes the tool registry).
    await mustRunDsh(
      bin,
      ["plugin", "--profile", "headless", "add", tarball],
      tarballHome,
    );
    const patchPath = join(workDir, "install-check.patch.yml");
    await writeFile(
      patchPath,
      `# Generated by tests/e2e/install-preview.ts — boot-time load check.
- id: session-title-llm
  disabled: true
- id: headless-runner
  disabled: true
- id: headless-startup
  disabled: true

- insert:
    - id: dsh-intercom-install-check
      name: '${pathToFileURL(join(E2E_DIR, "install-check.mjs")).href}'
`,
    );
    const boot = await runDsh(
      bin,
      ["--profile", "headless", "--patch", patchPath],
      tarballHome,
    );
    assert.equal(
      boot.code,
      0,
      `headless boot with the tarball-installed plugin failed:\n${boot.output}`,
    );
    assert.ok(
      boot.output.includes("[install-check] PASS"),
      `checker plugin did not report PASS:\n${boot.output}`,
    );
    out("tarball-installed plugin loads and registers the intercom tool");

    // 4. The README "Local development" link: flow against a separate scratch
    //    home (the same profile cannot hold two installs of the same plugin).
    const linkHome = join(workDir, "home-link");
    await mkdir(linkHome, { recursive: true });
    await mustRunDsh(
      bin,
      ["plugin", "--profile", "web", "add", `link:${REPO_ROOT}`],
      linkHome,
    );
    const linkDump = await mustRunDsh(
      bin,
      ["--profile", "web", "--dump-config"],
      linkHome,
    );
    assert.ok(
      linkDump.includes("dsh-intercom"),
      "dump-config does not list dsh-intercom after link: add",
    );
    out("link: install composes into the web profile");

    out("PASS");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(
    `[install] FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
