import { resolve } from "node:path";
import { realpathSync } from "node:fs";
//#region cwd.ts
const normalizeCache = /* @__PURE__ */ new Map();
function normalizeCwd(cwd) {
	const cached = normalizeCache.get(cwd);
	if (cached !== void 0) return cached;
	const resolved = resolve(cwd);
	let normalized;
	try {
		normalized = realpathSync(resolved);
	} catch {
		normalized = resolved;
	}
	normalizeCache.set(cwd, normalized);
	return normalized;
}
function sameCwd(a, b) {
	return normalizeCwd(a) === normalizeCwd(b);
}
//#endregion
export { normalizeCwd, sameCwd };
