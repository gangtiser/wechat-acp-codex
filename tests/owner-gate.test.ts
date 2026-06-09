import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOwnerGate } from "../src/bridge.js";
import { saveOwner, loadOwner } from "../src/storage/owner.js";

test("applyOwnerGate: bound owner passes, stranger is blocked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-gate-"));
  saveOwner(dir, "owner@x");
  assert.equal(applyOwnerGate({ storageDir: dir, sender: "owner@x", allowFirst: false }), true);
  assert.equal(applyOwnerGate({ storageDir: dir, sender: "stranger@x", allowFirst: false }), false);
});

test("applyOwnerGate: allowFirst binds and persists the first sender", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-gate2-"));
  assert.equal(applyOwnerGate({ storageDir: dir, sender: "first@x", allowFirst: true }), true);
  assert.equal(loadOwner(dir), "first@x");
  assert.equal(applyOwnerGate({ storageDir: dir, sender: "second@x", allowFirst: true }), false);
});
