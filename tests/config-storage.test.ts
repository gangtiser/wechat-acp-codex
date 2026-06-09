import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { defaultStorageDir, defaultConfig } from "../src/config.js";

test("default storage dir is ~/.wechat-acp-codex", () => {
  assert.equal(defaultStorageDir(), path.join(os.homedir(), ".wechat-acp-codex"));
});

test("instance is scoped under .wechat-acp-codex/instances", () => {
  assert.equal(defaultStorageDir("proj"), path.join(os.homedir(), ".wechat-acp-codex", "instances", "proj"));
});

test("defaultConfig: cwd is process.cwd(), log file is wechat-acp-codex.log", () => {
  const c = defaultConfig();
  assert.equal(c.agent.cwd, process.cwd());
  assert.ok(c.daemon.logFile.endsWith("wechat-acp-codex.log"), c.daemon.logFile);
});

test("defaultConfig: agent thinking is hidden by default", () => {
  const c = defaultConfig();
  assert.equal(c.agent.showThoughts, false);
});
