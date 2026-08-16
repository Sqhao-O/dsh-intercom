import test from "node:test";
import assert from "node:assert/strict";
import {
  formatIntercomMessage,
  formatSessionList,
  formatSessionListRow,
  sessionIdPrefixes,
} from "../src/message.ts";

test("formatIntercomMessage renders sender, cwd, reply hint, and body", () => {
  const text = formatIntercomMessage(
    { display: "planner", address: "planner", cwd: "D:/work/repo" },
    "hello worker",
  );
  assert.match(text, /^\*\*From planner\*\* \(D:\/work\/repo\)/);
  assert.match(
    text,
    /To reply, use the intercom tool: intercom\(\{ action: "send", to: "planner", message: "\.\.\." \}\)/,
  );
  assert.ok(text.endsWith("hello worker"));
});

test("formatIntercomMessage omits the cwd parenthetical when unknown", () => {
  const text = formatIntercomMessage(
    { display: "abcd1234", address: "abcd1234-full", cwd: undefined },
    "ping",
  );
  assert.match(text, /^\*\*From abcd1234\*\*\n/);
  assert.doesNotMatch(text, /\(undefined\)/);
  assert.match(text, /to: "abcd1234-full"/);
});

test("formatIntercomMessage quotes aliases that contain quotes", () => {
  const text = formatIntercomMessage(
    { display: 'my "agent"', address: 'my "agent"', cwd: "/x" },
    "body",
  );
  assert.match(text, /to: "my \\"agent\\""/);
});

test("formatIntercomMessage uses the reply-action hint for asks expecting a reply", () => {
  const text = formatIntercomMessage(
    { display: "planner", address: "planner", cwd: "D:/work/repo" },
    "can you review this?",
    { expectsReply: true, replyHint: true },
  );
  assert.match(text, /^\*\*From planner\*\* \(D:\/work\/repo\)/);
  assert.match(
    text,
    /To reply, use the intercom tool: intercom\(\{ action: "reply", message: "\.\.\." \}\)/,
  );
  assert.doesNotMatch(text, /action: "send"/);
  assert.ok(text.endsWith("can you review this?"));
});

test("formatIntercomMessage keeps the send hint when replyHint is off", () => {
  const text = formatIntercomMessage(
    { display: "planner", address: "planner", cwd: undefined },
    "can you review this?",
    { expectsReply: true, replyHint: false },
  );
  assert.match(text, /action: "send", to: "planner"/);
});

test("formatIntercomMessage keeps the send hint for ordinary messages", () => {
  const text = formatIntercomMessage(
    { display: "planner", address: "planner", cwd: undefined },
    "fyi",
    { expectsReply: false, replyHint: true },
  );
  assert.match(text, /action: "send", to: "planner"/);
});

test("sessionIdPrefixes extends prefixes past shared leading runs", () => {
  const prefixes = sessionIdPrefixes([
    "abcdef12-session",
    "abcdef99-session",
    "unique-one",
  ]);
  assert.equal(prefixes.get("abcdef12-session"), "abcdef12");
  assert.equal(prefixes.get("abcdef99-session"), "abcdef99");
  assert.equal(prefixes.get("unique-one"), "unique-o");
});

test("formatSessionListRow tags self, same cwd, and status", () => {
  const row = formatSessionListRow({
    display: "planner",
    idPrefix: "abcd1234",
    cwd: "/repo",
    model: "deepseek/deepseek-chat",
    status: "idle",
    self: true,
    sameCwd: false,
  });
  assert.equal(
    row,
    "• planner (abcd1234) — /repo (deepseek/deepseek-chat) [self, idle]",
  );
  const peer = formatSessionListRow({
    display: "Unnamed session",
    idPrefix: "def67890",
    cwd: "/repo",
    model: undefined,
    status: "running",
    self: false,
    sameCwd: true,
  });
  assert.equal(
    peer,
    "• Unnamed session (def67890) — /repo (unknown model) [same cwd, running]",
  );
});

test("formatSessionList sections current and other sessions", () => {
  assert.equal(
    formatSessionList("current-row", ["peer-1", "peer-2"]),
    "**Current session:**\ncurrent-row\n\n**Other sessions:**\npeer-1\npeer-2",
  );
  assert.equal(
    formatSessionList(undefined, []),
    "No live dsh sessions found in this process.",
  );
});
