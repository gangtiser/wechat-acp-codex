import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCliAgentSelection } from "../src/config.js";

test("defaults to codex when nothing is specified", () => {
  assert.equal(resolveCliAgentSelection({ defaultPreset: "codex" }), "codex");
});

test("--agent overrides config preset and command", () => {
  assert.equal(
    resolveCliAgentSelection({ argAgent: "claude", configPreset: "gemini", configCommand: "npx x", defaultPreset: "codex" }),
    "claude",
  );
});

test("config preset is used when there is no --agent", () => {
  assert.equal(resolveCliAgentSelection({ configPreset: "gemini", defaultPreset: "codex" }), "gemini");
});

test("raw config command (no preset, no --agent) is preserved, not defaulted", () => {
  assert.equal(
    resolveCliAgentSelection({ configCommand: "npx tsx ./agent.ts", defaultPreset: "codex" }),
    undefined,
  );
});
