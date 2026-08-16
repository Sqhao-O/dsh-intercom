import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import net from "net";
import { randomUUID } from "crypto";
import { createMessageReader, writeMessage } from "./framing.ts";
import {
  ensureIntercomRuntimeDir,
  getAgentDirPath,
  getBrokerConnectTarget,
  getIntercomDirPath,
  INTERCOM_PROTOCOL_NAME,
  INTERCOM_PROTOCOL_VERSION,
  INTERCOM_RUNTIME_FILE_MODE,
  restrictIntercomRuntimeFile,
  type BrokerConnectTarget,
} from "./paths.ts";

const INTERCOM_DIR = getIntercomDirPath();
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_PID = join(INTERCOM_DIR, "broker.pid");
const BROKER_SPAWN_LOCK = join(INTERCOM_DIR, "broker.spawn.lock");
const BROKER_STARTUP_STDERR_LIMIT = 4_000;

type BrokerLaunchSpec =
  | {
      kind: "direct";
      command: string;
      args: string[];
      captureStartupStderr: boolean;
    }
  | {
      kind: "windows-launcher";
      command: string;
      args: string[];
      launcherPath: string;
      launcherCommandLine: string;
      captureStartupStderr: boolean;
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The default broker launch is plain `node broker.js` against the compiled
 * output (lib/broker/broker.js sits next to the compiled spawn.js), so no
 * tsx/npx resolution is needed at runtime. A custom brokerCommand/brokerArgs
 * pair (e.g. ["bun", ["--smol"]]) overrides the executable but keeps the
 * broker script path as the final argument.
 */
export const DEFAULT_BROKER_COMMAND = "node";

function usesDefaultBrokerCommand(
  brokerCommand: string,
  brokerArgs: string[],
): boolean {
  return brokerCommand === DEFAULT_BROKER_COMMAND && brokerArgs.length === 0;
}

function quoteWindowsArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function getWindowsHiddenLauncherPath(
  intercomDir: string = INTERCOM_DIR,
): string {
  return join(intercomDir, "broker-launch.vbs");
}

function getNodeCommand(nodePath: string): string {
  const executableName = nodePath.split(/[\\/]/).pop();
  return executableName && /^node(?:js)?(?:\.exe)?$/i.test(executableName)
    ? nodePath
    : "node";
}

export function getWindowsBrokerCommandLine(
  brokerPath: string,
  nodePath: string = process.execPath,
  brokerCommand: string = DEFAULT_BROKER_COMMAND,
  brokerArgs: string[] = [],
): string {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return [
      quoteWindowsArg(getNodeCommand(nodePath)),
      quoteWindowsArg(brokerPath),
    ].join(" ");
  }

  return [
    quoteWindowsArg(brokerCommand),
    ...brokerArgs.map(quoteWindowsArg),
    quoteWindowsArg(brokerPath),
  ].join(" ");
}

export function getWindowsHiddenLauncherScript(commandLine: string): string {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    "Set WshShell = Nothing",
    "",
  ].join("\r\n");
}

export function isBrokerHealthOkMessage(
  message: unknown,
  requestId: string,
): boolean {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }
  const response = message as Record<string, unknown>;
  return (
    response.type === "health_ok" &&
    response.requestId === requestId &&
    response.protocol === INTERCOM_PROTOCOL_NAME &&
    response.version === INTERCOM_PROTOCOL_VERSION
  );
}

function writeWindowsHiddenLauncher(
  commandLine: string,
  launcherPath: string = getWindowsHiddenLauncherPath(),
): string {
  ensureIntercomRuntimeDir(dirname(launcherPath));
  writeFileSync(launcherPath, getWindowsHiddenLauncherScript(commandLine), {
    encoding: "utf-8",
    mode: INTERCOM_RUNTIME_FILE_MODE,
  });
  restrictIntercomRuntimeFile(launcherPath);
  return launcherPath;
}

export function getBrokerLaunchSpec(
  brokerPath: string,
  brokerCommand: string,
  brokerArgs: string[],
  platform: NodeJS.Platform = process.platform,
  intercomDir: string = INTERCOM_DIR,
  nodePath: string = process.execPath,
): BrokerLaunchSpec {
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: [launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsBrokerCommandLine(
        brokerPath,
        nodePath,
        brokerCommand,
        brokerArgs,
      ),
      captureStartupStderr: false,
    };
  }

  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return {
      kind: "direct",
      command: getNodeCommand(nodePath),
      args: [brokerPath],
      captureStartupStderr: true,
    };
  }

  return {
    kind: "direct",
    command: brokerCommand,
    args: [...brokerArgs, brokerPath],
    captureStartupStderr: false,
  };
}

export function getBrokerSpawnOptions(
  packageDir: string = PACKAGE_DIR,
  env: NodeJS.ProcessEnv = process.env,
  captureStderr = true,
): {
  detached: true;
  stdio: "ignore" | ["ignore", "ignore", "pipe"];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return {
    detached: true,
    stdio: captureStderr ? ["ignore", "ignore", "pipe"] : "ignore",
    cwd: packageDir,
    env: { ...env, DSH_HOME: getAgentDirPath(env), NODE_NO_WARNINGS: "1" },
    windowsHide: true,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function spawnBrokerIfNeeded(
  brokerCommand: string = DEFAULT_BROKER_COMMAND,
  brokerArgs: string[] = [],
): Promise<void> {
  ensureIntercomRuntimeDir(INTERCOM_DIR);

  if (await isBrokerRunning()) {
    return;
  }

  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }

  try {
    if (await isBrokerRunning()) {
      return;
    }

    // After build, this module is lib/broker/spawn.js and the runnable broker
    // entry point is lib/broker/broker.js right next to it.
    const brokerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "broker.js",
    );
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(
        launch.launcherCommandLine,
        launch.launcherPath,
      );
    }
    const child = spawn(
      launch.command,
      launch.args,
      getBrokerSpawnOptions(
        PACKAGE_DIR,
        process.env,
        launch.captureStartupStderr,
      ),
    );
    let brokerStderr = "";
    const rememberBrokerStderr = (chunk: Buffer | string) => {
      brokerStderr = `${brokerStderr}${chunk.toString()}`.slice(
        -BROKER_STARTUP_STDERR_LIMIT,
      );
    };
    const brokerStartupError = (message: string, cause?: unknown) => {
      const stderr = brokerStderr.trim();
      const errorMessage = stderr
        ? `${message}\nBroker stderr:\n${stderr}`
        : message;
      return cause === undefined
        ? new Error(errorMessage)
        : new Error(errorMessage, { cause });
    };
    child.stderr?.on("data", rememberBrokerStderr);
    // stdio pipes are net.Socket instances, which support unref().
    (child.stderr as net.Socket | null)?.unref();
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.stderr?.off("data", rememberBrokerStderr);
        child.stderr?.resume();
        child.off("error", onError);
        child.off("close", onExit);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(
          brokerStartupError(
            `Failed to spawn intercom broker: ${error.message}`,
            error,
          ),
        );
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (
          launch.kind === "windows-launcher" &&
          code === 0 &&
          signal === null
        ) {
          return;
        }
        cleanup();
        if (signal) {
          reject(
            brokerStartupError(
              `Intercom broker exited before startup with signal ${signal}`,
            ),
          );
          return;
        }
        reject(
          brokerStartupError(
            `Intercom broker exited before startup with code ${code ?? "unknown"}`,
          ),
        );
      };

      child.once("error", onError);
      child.once("close", onExit);
      waitForBroker().then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          const startupError = toError(error);
          reject(brokerStartupError(startupError.message, startupError));
        },
      );
    });
  } finally {
    releaseSpawnLock();
  }
}

async function isBrokerRunning(): Promise<boolean> {
  if (await checkSocketConnectable()) {
    return true;
  }

  if (!existsSync(BROKER_PID)) return false;

  try {
    const pid = parseInt(readFileSync(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    // Missing or unreadable PID state means there is no live broker to reuse.
    return false;
  }
}

function connectToBrokerTarget(target: BrokerConnectTarget): net.Socket {
  return typeof target === "string"
    ? net.connect(target)
    : net.connect({ host: target.host, port: target.port });
}

function checkSocketConnectable(): Promise<boolean> {
  return new Promise((resolve) => {
    let target: BrokerConnectTarget;
    try {
      target = getBrokerConnectTarget();
    } catch {
      resolve(false);
      return;
    }

    const socket = connectToBrokerTarget(target);
    const requestId = randomUUID();
    const expectedStateId =
      typeof target === "string" ? undefined : target.stateId;
    let settled = false;
    const finish = (isConnected: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("data", reader);
      socket.destroy();
      resolve(isConnected);
    };
    const onConnect = () => {
      try {
        writeMessage(socket, {
          type: "health",
          requestId,
          ...(expectedStateId ? { stateId: expectedStateId } : {}),
        });
      } catch {
        finish(false);
      }
    };
    const onError = () => finish(false);
    const reader = createMessageReader(
      (message) => {
        finish(isBrokerHealthOkMessage(message, requestId));
      },
      () => finish(false),
    );
    socket.on("connect", onConnect);
    socket.on("error", onError);
    socket.on("data", reader);
    const timeout = setTimeout(() => finish(false), 1000);
  });
}

function acquireSpawnLock(): boolean {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE,
      });
      restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
      return true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw error;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
          // If we can't delete the stale lock, retry a few times before giving up
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function isSpawnLockStale(): boolean {
  if (!existsSync(BROKER_SPAWN_LOCK)) {
    return false;
  }

  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync(
      BROKER_SPAWN_LOCK,
      "utf-8",
    )
      .trim()
      .split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;

    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        // The process that created the lock is gone.
        return true;
      }
    }

    return !Number.isFinite(createdAt) || ageMs > 10_000;
  } catch {
    // Unreadable lock contents are treated as stale so a new broker can start.
    return true;
  }
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
    // Another cleanup path may already have removed the lock.
  }
}

async function waitForBroker(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}
