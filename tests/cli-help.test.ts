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
