import { defineConfig } from "tsdown";

// The broker ships as committed build artifacts (dsh installs plugins from
// GitHub without a build step), so every source file maps to its own ESM
// output file under lib/ — lib/broker/broker.js must stay a standalone
// runnable entry point spawned via `node`.
export default defineConfig({
  entry: [
    "broker/ask-timeout.ts",
    "broker/broker.ts",
    "broker/client.ts",
    "broker/extension-state.ts",
    "broker/framing.ts",
    "broker/paths.ts",
    "broker/protocol.ts",
    "broker/runtime-claim.ts",
    "broker/spawn.ts",
    "types.ts",
    "cwd.ts",
    "src/index.ts",
    "src/message.ts",
    "src/registry.ts",
    "src/source.ts",
    "src/tool.ts",
    "src/transport/local.ts",
    "src/transport/types.ts",
  ],
  format: ["esm"],
  outDir: "lib",
  unbundle: true,
  dts: false,
  sourcemap: false,
  outExtensions: () => ({ js: ".js" }),
});
