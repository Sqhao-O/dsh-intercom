const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

export function getAskTimeoutMs(): number {
  const raw = process.env.DSH_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      "DSH_INTERCOM_ASK_TIMEOUT_MS must be a positive integer number of milliseconds",
    );
  }
  return value;
}
