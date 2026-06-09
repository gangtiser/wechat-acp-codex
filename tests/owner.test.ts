import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideOwnerGate, loadOwner, saveOwner, clearOwner, runOwnerCommand } from "../src/storage/owner.js";

test("gate: stored owner only allows that sender", () => {
  assert.deepEqual(decideOwnerGate({ storedOwner: "a@x", sender: "a@x", allowFirst: false }), { allowed: true });
  assert.deepEqual(decideOwnerGate({ storedOwner: "a@x", sender: "b@x", allowFirst: false }), { allowed: false });
});

test("gate: no owner + allowFirst binds the sender", () => {
  assert.deepEqual(decideOwnerGate({ storedOwner: null, sender: "a@x", allowFirst: true }), { allowed: true, bind: "a@x" });
});

test("gate: no owner + no allowFirst rejects", () => {
  assert.deepEqual(decideOwnerGate({ storedOwner: null, sender: "a@x", allowFirst: false }), { allowed: false });
});

test("persistence round-trips and clears", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-owner-"));
  assert.equal(loadOwner(dir), null);
  saveOwner(dir, "a@x");
  assert.equal(loadOwner(dir), "a@x");
  clearOwner(dir);
  assert.equal(loadOwner(dir), null);
});

test("runOwnerCommand: show prints owner, clear removes it, no action -> usage(1)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-ownercmd-"));
  const lines: string[] = [];
  saveOwner(dir, "a@x");
  assert.equal(runOwnerCommand(dir, "show", (m) => lines.push(m)), 0);
  assert.match(lines.at(-1)!, /a@x/);
  assert.equal(runOwnerCommand(dir, "clear", (m) => lines.push(m)), 0);
  assert.equal(loadOwner(dir), null);
  assert.equal(runOwnerCommand(dir, undefined, (m) => lines.push(m)), 1);
});
