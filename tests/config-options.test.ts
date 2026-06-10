import { test } from "node:test";
import assert from "node:assert/strict";
import { formatConfigList, formatConfigUsage, resolveConfigValue } from "../src/acp/config-options.js";

const usage = { command: "/acp-config", aliasHint: "" };

test("formatConfigList without a session falls back to usage with a hint", () => {
  const out = formatConfigList(undefined, usage);
  assert.match(out, /No active ACP session/);
  assert.match(out, /\/acp-config set <configId> <value>/);
});

test("formatConfigUsage renders the alias hint suffix", () => {
  const out = formatConfigUsage({ command: "/acp-config", aliasHint: " (aliases: /配置)" });
  assert.match(out, /\/acp-config \(aliases: \/配置\)/);
});

test("resolveConfigValue parses booleans loosely", () => {
  const options = [{ id: "verbose", name: "Verbose", type: "boolean", currentValue: false }] as never;
  assert.deepEqual(resolveConfigValue(options, "verbose", "ON"), { rawValue: true, displayValue: "true" });
  assert.deepEqual(resolveConfigValue(options, "verbose", "0"), { rawValue: false, displayValue: "false" });
  assert.throws(() => resolveConfigValue(options, "verbose", "maybe"), /Invalid boolean value/);
});

test("resolveConfigValue matches select choices by name and value tail", () => {
  const options = [{
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "providers/openai#gpt-x",
    options: [
      { value: "providers/openai#gpt-x", name: "GPT X" },
      { value: "providers/zai#glm", name: "GLM" },
    ],
  }] as never;
  assert.equal(resolveConfigValue(options, "model", "gpt-x").rawValue, "providers/openai#gpt-x");
  assert.equal(resolveConfigValue(options, "model", "GLM").rawValue, "providers/zai#glm");
  assert.throws(() => resolveConfigValue(options, "model", "nope"), /Invalid value for model/);
  assert.throws(() => resolveConfigValue(options, "other", "x"), /Unknown ACP config option/);
  assert.throws(() => resolveConfigValue(undefined, "model", "x"), /No active ACP session/);
});
