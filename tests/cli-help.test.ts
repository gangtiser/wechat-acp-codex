import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("CLI help exposes --show-thoughts as opt-in", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "bin/wechat-acp-codex.ts", "--help"],
    { encoding: "utf-8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--show-thoughts\s+Forward agent thinking to WeChat \(default: hidden\)/);
});

test("CLI rejects a non-numeric --max-sessions instead of silently ignoring it", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "bin/wechat-acp-codex.ts", "--max-sessions", "abc"],
    { encoding: "utf-8" },
  );

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /invalid --max-sessions/);
});

test("CLI rejects --max-sessions 0", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "bin/wechat-acp-codex.ts", "--max-sessions", "0"],
    { encoding: "utf-8" },
  );

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /invalid --max-sessions/);
});

test("CLI rejects a value flag that would swallow the next flag", () => {
  // `--agent --daemon` must not silently set agent="--daemon" and drop --daemon.
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx/esm", "bin/wechat-acp-codex.ts", "--agent", "--daemon"],
    { encoding: "utf-8" },
  );

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--agent requires a value/);
});
