import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as telemetry from "../src/telemetry/index.js";

test("network telemetry functions are no-ops and never throw", async () => {
  assert.doesNotThrow(() => telemetry.initTelemetry({ version: "0.0.0", storageDir: "/tmp/wc-test" }));
  assert.doesNotThrow(() => telemetry.trackEvent("app.start"));
  assert.doesNotThrow(() => telemetry.trackException(new Error("x"), "area"));
  await assert.doesNotReject(telemetry.shutdownTelemetry());
});

test("hashUserId is a no-op stub that never computes a hash", () => {
  // Telemetry is disabled, so it returns a constant (no sha256) and never echoes
  // the raw id back.
  assert.equal(telemetry.hashUserId(""), "");
  assert.equal(telemetry.hashUserId("user@im.wechat"), "");
});

test("applicationinsights is not a dependency (Azure removed)", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  assert.ok(!pkg.dependencies?.applicationinsights, "applicationinsights must be removed from dependencies");
});
