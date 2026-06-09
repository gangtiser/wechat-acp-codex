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

test("hashUserId stays a pure, stable, non-reversible hash", () => {
  assert.equal(telemetry.hashUserId(""), "");
  const h = telemetry.hashUserId("user@im.wechat");
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, telemetry.hashUserId("user@im.wechat"));
  assert.notEqual(h, "user@im.wechat");
});

test("applicationinsights is not a dependency (Azure removed)", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
  assert.ok(!pkg.dependencies?.applicationinsights, "applicationinsights must be removed from dependencies");
});
