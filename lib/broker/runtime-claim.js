import { existsSync, readFileSync } from "node:fs";
//#region broker/runtime-claim.ts
function assertNoLiveBroker(pidPath) {
	if (!existsSync(pidPath)) return;
	let pid;
	try {
		pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	} catch {
		return;
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error.code === "ESRCH") return;
		throw error;
	}
	throw new Error(`Refusing to replace live intercom broker process ${pid}`);
}
//#endregion
export { assertNoLiveBroker };
