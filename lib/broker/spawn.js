import { createMessageReader, writeMessage } from "./framing.js";
import { ensureIntercomRuntimeDir, getAgentDirPath, getBrokerConnectTarget, getIntercomDirPath, restrictIntercomRuntimeFile } from "./paths.js";
import net from "net";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
//#region broker/spawn.ts
const INTERCOM_DIR = getIntercomDirPath();
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_PID = join(INTERCOM_DIR, "broker.pid");
const BROKER_SPAWN_LOCK = join(INTERCOM_DIR, "broker.spawn.lock");
const BROKER_STARTUP_STDERR_LIMIT = 4e3;
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
* The default broker launch is plain `node broker.js` against the compiled
* output (lib/broker/broker.js sits next to the compiled spawn.js), so no
* tsx/npx resolution is needed at runtime. A custom brokerCommand/brokerArgs
* pair (e.g. ["bun", ["--smol"]]) overrides the executable but keeps the
* broker script path as the final argument.
*/
const DEFAULT_BROKER_COMMAND = "node";
function usesDefaultBrokerCommand(brokerCommand, brokerArgs) {
	return brokerCommand === "node" && brokerArgs.length === 0;
}
function quoteWindowsArg(value) {
	return `"${value.replace(/"/g, "\"\"")}"`;
}
function getWindowsHiddenLauncherPath(intercomDir = INTERCOM_DIR) {
	return join(intercomDir, "broker-launch.vbs");
}
function getNodeCommand(nodePath) {
	const executableName = nodePath.split(/[\\/]/).pop();
	return executableName && /^node(?:js)?(?:\.exe)?$/i.test(executableName) ? nodePath : "node";
}
function getWindowsBrokerCommandLine(brokerPath, nodePath = process.execPath, brokerCommand = DEFAULT_BROKER_COMMAND, brokerArgs = []) {
	if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) return [quoteWindowsArg(getNodeCommand(nodePath)), quoteWindowsArg(brokerPath)].join(" ");
	return [
		quoteWindowsArg(brokerCommand),
		...brokerArgs.map(quoteWindowsArg),
		quoteWindowsArg(brokerPath)
	].join(" ");
}
function getWindowsHiddenLauncherScript(commandLine) {
	return [
		"Set WshShell = CreateObject(\"WScript.Shell\")",
		`WshShell.Run "${commandLine.replace(/"/g, "\"\"")}", 0, False`,
		"Set WshShell = Nothing",
		""
	].join("\r\n");
}
function isBrokerHealthOkMessage(message, requestId) {
	if (typeof message !== "object" || message === null || !("type" in message)) return false;
	const response = message;
	return response.type === "health_ok" && response.requestId === requestId && response.protocol === "dsh-intercom" && response.version === 1;
}
function writeWindowsHiddenLauncher(commandLine, launcherPath = getWindowsHiddenLauncherPath()) {
	ensureIntercomRuntimeDir(dirname(launcherPath));
	writeFileSync(launcherPath, getWindowsHiddenLauncherScript(commandLine), {
		encoding: "utf-8",
		mode: 384
	});
	restrictIntercomRuntimeFile(launcherPath);
	return launcherPath;
}
function getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs, platform = process.platform, intercomDir = INTERCOM_DIR, nodePath = process.execPath) {
	if (platform === "win32") {
		const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
		return {
			kind: "windows-launcher",
			command: "wscript.exe",
			args: [launcherPath],
			launcherPath,
			launcherCommandLine: getWindowsBrokerCommandLine(brokerPath, nodePath, brokerCommand, brokerArgs),
			captureStartupStderr: false
		};
	}
	if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) return {
		kind: "direct",
		command: getNodeCommand(nodePath),
		args: [brokerPath],
		captureStartupStderr: true
	};
	return {
		kind: "direct",
		command: brokerCommand,
		args: [...brokerArgs, brokerPath],
		captureStartupStderr: false
	};
}
function getBrokerSpawnOptions(packageDir = PACKAGE_DIR, env = process.env, captureStderr = true) {
	return {
		detached: true,
		stdio: captureStderr ? [
			"ignore",
			"ignore",
			"pipe"
		] : "ignore",
		cwd: packageDir,
		env: {
			...env,
			DSH_HOME: getAgentDirPath(env),
			NODE_NO_WARNINGS: "1"
		},
		windowsHide: true
	};
}
function toError(error) {
	return error instanceof Error ? error : new Error(String(error));
}
async function spawnBrokerIfNeeded(brokerCommand = DEFAULT_BROKER_COMMAND, brokerArgs = []) {
	ensureIntercomRuntimeDir(INTERCOM_DIR);
	if (await isBrokerRunning()) return;
	if (!acquireSpawnLock()) {
		await waitForBroker();
		return;
	}
	try {
		if (await isBrokerRunning()) return;
		const launch = getBrokerLaunchSpec(join(dirname(fileURLToPath(import.meta.url)), "broker.js"), brokerCommand, brokerArgs);
		if (launch.kind === "windows-launcher") writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
		const child = spawn(launch.command, launch.args, getBrokerSpawnOptions(PACKAGE_DIR, process.env, launch.captureStartupStderr));
		let brokerStderr = "";
		const rememberBrokerStderr = (chunk) => {
			brokerStderr = `${brokerStderr}${chunk.toString()}`.slice(-BROKER_STARTUP_STDERR_LIMIT);
		};
		const brokerStartupError = (message, cause) => {
			const stderr = brokerStderr.trim();
			const errorMessage = stderr ? `${message}\nBroker stderr:\n${stderr}` : message;
			return cause === void 0 ? new Error(errorMessage) : new Error(errorMessage, { cause });
		};
		child.stderr?.on("data", rememberBrokerStderr);
		child.stderr?.unref();
		child.unref();
		await new Promise((resolve, reject) => {
			const cleanup = () => {
				child.stderr?.off("data", rememberBrokerStderr);
				child.stderr?.resume();
				child.off("error", onError);
				child.off("close", onExit);
			};
			const onError = (error) => {
				cleanup();
				reject(brokerStartupError(`Failed to spawn intercom broker: ${error.message}`, error));
			};
			const onExit = (code, signal) => {
				if (launch.kind === "windows-launcher" && code === 0 && signal === null) return;
				cleanup();
				if (signal) {
					reject(brokerStartupError(`Intercom broker exited before startup with signal ${signal}`));
					return;
				}
				reject(brokerStartupError(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
			};
			child.once("error", onError);
			child.once("close", onExit);
			waitForBroker().then(() => {
				cleanup();
				resolve();
			}, (error) => {
				cleanup();
				const startupError = toError(error);
				reject(brokerStartupError(startupError.message, startupError));
			});
		});
	} finally {
		releaseSpawnLock();
	}
}
async function isBrokerRunning() {
	if (await checkSocketConnectable()) return true;
	if (!existsSync(BROKER_PID)) return false;
	try {
		const pid = parseInt(readFileSync(BROKER_PID, "utf-8").trim(), 10);
		if (!Number.isFinite(pid)) return false;
		process.kill(pid, 0);
		return checkSocketConnectable();
	} catch {
		return false;
	}
}
function connectToBrokerTarget(target) {
	return typeof target === "string" ? net.connect(target) : net.connect({
		host: target.host,
		port: target.port
	});
}
function checkSocketConnectable() {
	return new Promise((resolve) => {
		let target;
		try {
			target = getBrokerConnectTarget();
		} catch {
			resolve(false);
			return;
		}
		const socket = connectToBrokerTarget(target);
		const requestId = randomUUID();
		const expectedStateId = typeof target === "string" ? void 0 : target.stateId;
		let settled = false;
		const finish = (isConnected) => {
			if (settled) return;
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
					...expectedStateId ? { stateId: expectedStateId } : {}
				});
			} catch {
				finish(false);
			}
		};
		const onError = () => finish(false);
		const reader = createMessageReader((message) => {
			finish(isBrokerHealthOkMessage(message, requestId));
		}, () => finish(false));
		socket.on("connect", onConnect);
		socket.on("error", onError);
		socket.on("data", reader);
		const timeout = setTimeout(() => finish(false), 1e3);
	});
}
function acquireSpawnLock() {
	const maxRetries = 5;
	for (let attempt = 0; attempt < maxRetries; attempt++) try {
		writeFileSync(BROKER_SPAWN_LOCK, `${process.pid}\n${Date.now()}\n`, {
			flag: "wx",
			mode: 384
		});
		restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
		return true;
	} catch (error) {
		if (!(error instanceof Error) || error.code !== "EEXIST") throw error;
		if (isSpawnLockStale()) {
			try {
				unlinkSync(BROKER_SPAWN_LOCK);
			} catch {}
			continue;
		}
		return false;
	}
	return false;
}
function isSpawnLockStale() {
	if (!existsSync(BROKER_SPAWN_LOCK)) return false;
	try {
		const [pidLine = "", createdAtLine = "0"] = readFileSync(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
		const pid = Number.parseInt(pidLine, 10);
		const createdAt = Number.parseInt(createdAtLine, 10);
		const ageMs = Date.now() - createdAt;
		if (Number.isFinite(pid)) try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		return !Number.isFinite(createdAt) || ageMs > 1e4;
	} catch {
		return true;
	}
}
function releaseSpawnLock() {
	try {
		unlinkSync(BROKER_SPAWN_LOCK);
	} catch {}
}
async function waitForBroker(timeoutMs = 5e3) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await checkSocketConnectable()) return;
		await sleep(100);
	}
	throw new Error("Broker failed to start within timeout");
}
//#endregion
export { DEFAULT_BROKER_COMMAND, getBrokerLaunchSpec, getBrokerSpawnOptions, getWindowsBrokerCommandLine, getWindowsHiddenLauncherPath, getWindowsHiddenLauncherScript, isBrokerHealthOkMessage, spawnBrokerIfNeeded };
