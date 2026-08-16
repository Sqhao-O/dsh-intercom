/**
 * Install-preview checker plugin (M3). Mounted into a scratch headless profile
 * via --patch AFTER `dsh plugin add` installed dsh-intercom from a tarball; it
 * only verifies the installed plugin actually LOADED (its module imported
 * without errors and its apply() registered the intercom tool), then exits.
 * Plain .mjs: the dsh Loader imports this file URL directly (no build step).
 */
export const name = "dsh-intercom-install-check";
export const inject = ["tools"];

const tag = "[install-check]";

export function apply(ctx) {
  const timer = setTimeout(() => {
    process.stdout.write(`${tag} FAIL timeout waiting for the loader\n`);
    process.exit(2);
  }, 60_000);
  void (async () => {
    try {
      // Sibling plugins mount concurrently; wait for the whole tree
      // (dsh-intercom among them) before touching the tool registry.
      await ctx.get("loader")?.await();
      const tool = ctx.tools.get("intercom");
      if (!tool) {
        throw new Error("intercom tool is not registered");
      }
      process.stdout.write(`${tag} PASS intercom tool registered\n`);
      clearTimeout(timer);
      const appExit = ctx.get("appExit");
      if (typeof appExit === "function") appExit(0);
      else process.exit(0);
    } catch (error) {
      process.stdout.write(
        `${tag} FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      clearTimeout(timer);
      process.exit(1);
    }
  })();
}
