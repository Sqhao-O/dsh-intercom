import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig } from "../src/config.ts";

async function withDshHome<T>(
  dshHome: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

function withTempHome(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "dsh-intercom-config-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("getConfigPath uses the centralized intercom runtime directory", () => {
  assert.equal(
    getConfigPath(join("/tmp", "dsh-agent", "intercom")),
    join("/tmp", "dsh-agent", "intercom", "config.json"),
  );
});

test("loadConfig returns defaults when no config file exists", () => {
  withTempHome((root) => {
    withDshHome(root, () => {
      assert.deepEqual(loadConfig(), {
        enabled: true,
        inboundTrigger: "always",
        replyHint: true,
        confirmSend: false,
      });
    });
  });
});

test("loadConfig reads config below DSH_HOME", () => {
  withTempHome((root) => {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(
      join(root, "intercom", "config.json"),
      JSON.stringify({
        enabled: false,
        inboundTrigger: "replies",
        replyHint: false,
        status: "platform-test",
        confirmSend: true,
      }),
    );
    withDshHome(root, () => {
      assert.deepEqual(loadConfig(), {
        enabled: false,
        inboundTrigger: "replies",
        replyHint: false,
        status: "platform-test",
        confirmSend: true,
      });
    });
  });
});

test("loadConfig accepts the confirmSend key as a documented no-op", () => {
  withTempHome((root) => {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(
      join(root, "intercom", "config.json"),
      JSON.stringify({ confirmSend: true }),
    );
    withDshHome(root, () => {
      // Parsed and stored (so a future implementation can honor it), but the
      // plugin never gates sends on it — see the config.ts doc comment.
      assert.equal(loadConfig().confirmSend, true);
    });
  });
});

test("malformed JSON fails closed with inboundTrigger never and logs", () => {
  withTempHome((root) => {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), "{ not json");
    const warnings: string[] = [];
    withDshHome(root, () => {
      const config = loadConfig((message) => warnings.push(message));
      assert.equal(config.inboundTrigger, "never");
      assert.equal(config.enabled, true);
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /failed to load config/);
    assert.match(warnings[0]!, /inboundTrigger: "never"/);
  });
});

test("invalid values fail closed the same way", () => {
  withTempHome((root) => {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(
      join(root, "intercom", "config.json"),
      JSON.stringify({ inboundTrigger: "prompt" }),
    );
    const warnings: string[] = [];
    withDshHome(root, () => {
      const config = loadConfig((message) => warnings.push(message));
      assert.equal(config.inboundTrigger, "never");
    });
    assert.match(
      warnings[0]!,
      /"inboundTrigger" must be "always", "replies", or "never"/,
    );
  });
});

test("a non-object config fails closed", () => {
  withTempHome((root) => {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify([1]));
    const warnings: string[] = [];
    withDshHome(root, () => {
      assert.equal(loadConfig((m) => warnings.push(m)).inboundTrigger, "never");
    });
    assert.match(warnings[0]!, /Config must be a JSON object/);
  });
});
