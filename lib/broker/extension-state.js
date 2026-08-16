import { dirname, join } from "node:path";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
//#region broker/extension-state.ts
const MAX_STATE_BYTES = 65536;
function serializePayload(payload) {
	try {
		const json = JSON.stringify(payload);
		if (json === void 0 || Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) return null;
		return json;
	} catch {
		return null;
	}
}
function payloadHash(payloadJson) {
	return createHash("sha256").update(payloadJson).digest("hex");
}
var ExtensionStateManager = class {
	states = /* @__PURE__ */ new Map();
	stateDir;
	constructor(runtimeDir) {
		this.stateDir = join(runtimeDir, "extension-state");
		mkdirSync(this.stateDir, {
			recursive: true,
			mode: 448
		});
	}
	statePath(namespace) {
		const hash = createHash("sha256").update(namespace).digest("hex");
		return join(this.stateDir, `${hash}.json`);
	}
	backupPath(namespace) {
		return `${this.statePath(namespace)}.bak`;
	}
	readEnvelope(filePath, namespace) {
		if (!existsSync(filePath)) return null;
		try {
			const content = readFileSync(filePath, "utf8");
			const value = JSON.parse(content);
			if (!value || typeof value !== "object" || Array.isArray(value)) return null;
			const envelope = value;
			const revision = envelope.revision;
			const updatedAt = envelope.updatedAt;
			const payloadSha256 = envelope.payloadSha256;
			if (envelope.formatVersion !== 1 || envelope.namespace !== namespace || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || typeof updatedAt !== "number" || typeof payloadSha256 !== "string") return null;
			const payloadJson = serializePayload(envelope.payload);
			if (payloadJson === null || payloadHash(payloadJson) !== payloadSha256) return null;
			return {
				formatVersion: 1,
				namespace,
				revision,
				updatedAt,
				payloadSha256,
				payload: envelope.payload
			};
		} catch {
			return null;
		}
	}
	loadState(namespace) {
		const cached = this.states.get(namespace);
		if (cached) return cached;
		const envelope = this.readEnvelope(this.statePath(namespace), namespace) ?? this.readEnvelope(this.backupPath(namespace), namespace);
		if (!envelope) return null;
		const state = {
			revision: envelope.revision,
			payload: envelope.payload
		};
		this.states.set(namespace, state);
		return state;
	}
	commitState(namespace, expectedRevision, payload) {
		const payloadJson = serializePayload(payload);
		const current = this.loadState(namespace);
		const currentRevision = current?.revision ?? 0;
		if (payloadJson === null) return {
			committed: false,
			revision: currentRevision,
			reason: "Invalid extension state or payload exceeds 64 KiB limit"
		};
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return {
			committed: false,
			revision: currentRevision,
			reason: "Invalid expected revision"
		};
		if (expectedRevision !== currentRevision) return {
			committed: false,
			revision: currentRevision,
			reason: "Revision mismatch",
			...current ? { payload: current.payload } : {}
		};
		const envelope = {
			formatVersion: 1,
			namespace,
			revision: currentRevision + 1,
			updatedAt: Date.now(),
			payloadSha256: payloadHash(payloadJson),
			payload
		};
		const statePath = this.statePath(namespace);
		const backupPath = this.backupPath(namespace);
		const tempPath = `${statePath}.tmp.${process.pid}.${randomUUID()}`;
		try {
			writeFileSync(tempPath, JSON.stringify(envelope), { mode: 384 });
			const file = openSync(tempPath, "r+");
			try {
				fsyncSync(file);
			} finally {
				closeSync(file);
			}
			if (this.readEnvelope(statePath, namespace)) copyFileSync(statePath, backupPath);
			renameSync(tempPath, statePath);
			try {
				const directory = openSync(dirname(statePath), "r");
				try {
					fsyncSync(directory);
				} finally {
					closeSync(directory);
				}
			} catch {}
			const state = {
				revision: envelope.revision,
				payload
			};
			this.states.set(namespace, state);
			return {
				committed: true,
				revision: envelope.revision
			};
		} catch {
			return {
				committed: false,
				revision: currentRevision,
				reason: "Failed to persist extension state"
			};
		} finally {
			rmSync(tempPath, { force: true });
		}
	}
	getCurrentRevision(namespace) {
		return this.loadState(namespace)?.revision ?? 0;
	}
};
//#endregion
export { ExtensionStateManager };
