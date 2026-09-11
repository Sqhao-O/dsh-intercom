import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getBrokerLaunchSpec,
  getBrokerSpawnOptions,
  getWindowsHiddenLauncherScript,
  getWindowsBrokerCommandLine,
  getWindowsHiddenLauncherPath,
  isBrokerHealthOkMessage,
} from "./spawn.ts";

test("getWindowsHiddenLauncherPath points at the broker launcher script", () => {
  const launcherPath = getWindowsHiddenLauncherPath("C:/tmp/intercom");
  assert.equal(launcherPath, path.join("C:/tmp/intercom", "broker-launch.vbs"));
});

test("getWindowsBrokerCommandLine defaults to node plus the compiled broker path", () => {
  const commandLine = getWindowsBrokerCommandLine(
    "C:/repo/lib/broker/broker.js",
    "C:/Program Files/nodejs/node.exe",
  );
  assert.equal(
    commandLine,
    `"C:/Program Files/nodejs/node.exe" "C:/repo/lib/broker/broker.js"`,
  );
});

test("getWindowsBrokerCommandLine uses the custom broker command when provided", () => {
  const commandLine = getWindowsBrokerCommandLine(
    "C:/repo/lib/broker/broker.js",
    "C:/Program Files/nodejs/node.exe",
    "bun",
    ["--smol"],
  );
  assert.equal(commandLine, `"bun" "--smol" "C:/repo/lib/broker/broker.js"`);
});

test("getWindowsHiddenLauncherScript runs the broker command without showing a console", () => {
  const script = getWindowsHiddenLauncherScript(
    '"C:/Program Files/nodejs/node.exe" "C:/repo/lib/broker/broker.js"',
  );
  assert.match(script, /WshShell\.Run/);
  assert.match(script, /, 0, False/);
});

test("getBrokerLaunchSpec uses wscript launcher on Windows without writing files", () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "dsh-intercom-"));

  try {
    const spec = getBrokerLaunchSpec(
      "C:/repo/lib/broker/broker.js",
      "node",
      [],
      "win32",
      intercomDir,
      "C:/Program Files/nodejs/node.exe",
    );
    assert.equal(spec.command, "wscript.exe");
    assert.deepEqual(spec.args, [path.join(intercomDir, "broker-launch.vbs")]);
    assert.equal(spec.kind, "windows-launcher");
    assert.equal(
      spec.launcherCommandLine,
      `"C:/Program Files/nodejs/node.exe" "C:/repo/lib/broker/broker.js"`,
    );
    assert.equal(spec.captureStartupStderr, false);
    assert.equal(
      existsSync(path.join(intercomDir, "broker-launch.vbs")),
      false,
    );
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec falls back to PATH node for a non-node host executable on Windows", () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "dsh-intercom-"));

  try {
    const spec = getBrokerLaunchSpec(
      "C:/repo/lib/broker/broker.js",
      "node",
      [],
      "win32",
      intercomDir,
      "C:/Program Files/dsh/dsh.exe",
    );
    assert.equal(spec.kind, "windows-launcher");
    assert.equal(
      spec.launcherCommandLine,
      `"node" "C:/repo/lib/broker/broker.js"`,
    );
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec uses custom broker command on Windows", () => {
  const intercomDir = mkdtempSync(path.join(tmpdir(), "dsh-intercom-"));

  try {
    const spec = getBrokerLaunchSpec(
      "C:/repo/lib/broker/broker.js",
      "bun",
      ["--smol"],
      "win32",
      intercomDir,
      "C:/Program Files/nodejs/node.exe",
    );
    assert.equal(spec.command, "wscript.exe");
    assert.equal(spec.kind, "windows-launcher");
    assert.equal(
      spec.launcherCommandLine,
      `"bun" "--smol" "C:/repo/lib/broker/broker.js"`,
    );
  } finally {
    rmSync(intercomDir, { recursive: true, force: true });
  }
});

test("getBrokerLaunchSpec uses node + compiled broker.js for the default non-Windows launch", () => {
  const spec = getBrokerLaunchSpec(
    "/repo/lib/broker/broker.js",
    "node",
    [],
    "linux",
    "/tmp/intercom",
    "/usr/bin/node",
  );
  assert.equal(spec.command, "/usr/bin/node");
  assert.deepEqual(spec.args, ["/repo/lib/broker/broker.js"]);
  assert.equal(spec.kind, "direct");
  assert.equal(spec.captureStartupStderr, true);
});

test("getBrokerLaunchSpec falls back to PATH node for a non-node host executable on non-Windows", () => {
  const spec = getBrokerLaunchSpec(
    "/repo/lib/broker/broker.js",
    "node",
    [],
    "darwin",
    "/tmp/intercom",
    "/Applications/dsh.app/Contents/MacOS/dsh",
  );
  assert.equal(spec.command, "node");
  assert.deepEqual(spec.args, ["/repo/lib/broker/broker.js"]);
  assert.equal(spec.kind, "direct");
});

test("getBrokerLaunchSpec uses custom broker command on non-Windows", () => {
  const spec = getBrokerLaunchSpec(
    "/repo/lib/broker/broker.js",
    "bun",
    [],
    "linux",
    "/tmp/intercom",
    "/usr/bin/node",
  );
  assert.equal(spec.command, "bun");
  assert.deepEqual(spec.args, ["/repo/lib/broker/broker.js"]);
  assert.equal(spec.kind, "direct");
  assert.equal(spec.captureStartupStderr, false);
});

test("getBrokerSpawnOptions hides the broker console window on Windows", () => {
  const options = getBrokerSpawnOptions("C:/repo");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(options.cwd, "C:/repo");
});

test("getBrokerSpawnOptions keeps portable defaults on non-Windows platforms", () => {
  const options = getBrokerSpawnOptions("/repo");
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(options.cwd, "/repo");
});

test("getBrokerSpawnOptions can keep custom broker stderr ignored", () => {
  const options = getBrokerSpawnOptions("/repo", process.env, false);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.cwd, "/repo");
});

test("getBrokerSpawnOptions passes an absolute DSH_HOME to the broker", () => {
  const options = getBrokerSpawnOptions("/repo", { DSH_HOME: "relative-home" });
  assert.equal(options.env.DSH_HOME, path.resolve("relative-home"));
});

test("spawnBrokerIfNeeded surfaces default broker startup failures", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "dsh-intercom-spawn-"));
  const packageDir = path.join(root, "dsh-intercom");
  const brokerDir = path.join(packageDir, "broker");
  const previousDshHome = process.env.DSH_HOME;

  try {
    mkdirSync(brokerDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    // The default launch is `node broker.js`; a failing broker.js stands in for
    // a broken compiled artifact.
    writeFileSync(
      path.join(brokerDir, "broker.js"),
      "process.stderr.write('fake broker failed\\n'); process.exit(1);\n",
    );

    const sourceDir = path.dirname(fileURLToPath(import.meta.url));
    for (const fileName of ["spawn.ts", "framing.ts", "paths.ts"]) {
      cpSync(path.join(sourceDir, fileName), path.join(brokerDir, fileName));
    }

    process.env.DSH_HOME = path.join(root, "dsh-home");
    const moduleUrl = `${pathToFileURL(path.join(brokerDir, "spawn.ts")).href}?case=${Date.now()}`;
    const imported = (await import(moduleUrl)) as typeof import("./spawn.ts");

    await assert.rejects(
      () => imported.spawnBrokerIfNeeded(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        if (process.platform === "win32") {
          // The Windows hidden launcher detaches via wscript, so startup stderr
          // is not captured; the failure surfaces as a startup timeout instead.
          assert.match(error.message, /Broker failed to start within timeout/);
        } else {
          assert.match(
            error.message,
            /Intercom broker exited before startup with code 1/,
          );
          assert.match(error.message, /Broker stderr:\nfake broker failed/);
        }
        return true;
      },
    );
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

test("isBrokerHealthOkMessage requires the intercom protocol marker", () => {
  assert.equal(
    isBrokerHealthOkMessage(
      {
        type: "health_ok",
        requestId: "req-1",
        protocol: "dsh-intercom",
        version: 1,
      },
      "req-1",
    ),
    true,
  );
  assert.equal(
    isBrokerHealthOkMessage({ type: "health_ok", requestId: "req-1" }, "req-1"),
    false,
  );
  assert.equal(
    isBrokerHealthOkMessage(
      {
        type: "health_ok",
        requestId: "req-2",
        protocol: "dsh-intercom",
        version: 1,
      },
      "req-1",
    ),
    false,
  );
  assert.equal(isBrokerHealthOkMessage("ok", "req-1"), false);
});
