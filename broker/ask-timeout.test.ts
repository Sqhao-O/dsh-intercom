import test from "node:test";
import assert from "node:assert/strict";
import { getAskTimeoutMs } from "./ask-timeout.ts";

const ENV_KEY = "DSH_INTERCOM_ASK_TIMEOUT_MS";

function withAskTimeoutEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  }
}

test("getAskTimeoutMs defaults to 10 minutes", () => {
  withAskTimeoutEnv(undefined, () => {
    assert.equal(getAskTimeoutMs(), 10 * 60 * 1000);
  });
});

test("getAskTimeoutMs treats an empty value as unset", () => {
  withAskTimeoutEnv("   ", () => {
    assert.equal(getAskTimeoutMs(), 10 * 60 * 1000);
  });
});

test("getAskTimeoutMs honors DSH_INTERCOM_ASK_TIMEOUT_MS", () => {
  withAskTimeoutEnv("5000", () => {
    assert.equal(getAskTimeoutMs(), 5000);
  });
});

test("getAskTimeoutMs rejects non-positive or non-integer values", () => {
  for (const value of ["0", "-5", "1.5", "abc"]) {
    withAskTimeoutEnv(value, () => {
      assert.throws(
        () => getAskTimeoutMs(),
        /DSH_INTERCOM_ASK_TIMEOUT_MS must be a positive integer/,
      );
    });
  }
});
