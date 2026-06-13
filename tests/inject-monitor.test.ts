import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InjectionMonitor } from "../src/inject/monitor.js";

async function tmpInjectDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "inject-test-"));
}

async function dropPending(dir: string, id: string): Promise<void> {
  await fs.mkdir(path.join(dir, "pending"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "pending", `${id}.json`),
    JSON.stringify({ id, createdAt: new Date().toISOString(), target: "u1", text: "hi", source: "cli" }),
  );
}

test("processed inject job is removed, not accumulated in a done/ dir", async () => {
  const dir = await tmpInjectDir();
  // Drop the job before start() so the initial synchronous drain processes it.
  await dropPending(dir, "inj_a");

  const seen: string[] = [];
  const monitor = new InjectionMonitor({
    injectDir: dir,
    log: () => {},
    onMessage: async (job) => { seen.push(job.id); },
  });
  await monitor.start();
  await monitor.stop();

  assert.deepEqual(seen, ["inj_a"]);
  assert.deepEqual(await fs.readdir(path.join(dir, "pending")), []);
  assert.deepEqual(await fs.readdir(path.join(dir, "processing")), []);
  // No done/ accumulation — the dir should not even exist.
  await assert.rejects(fs.readdir(path.join(dir, "done")), /ENOENT/);
});

test("failed inject job moves to failed/", async () => {
  const dir = await tmpInjectDir();
  await dropPending(dir, "inj_b");

  const monitor = new InjectionMonitor({
    injectDir: dir,
    log: () => {},
    onMessage: async () => { throw new Error("boom"); },
  });
  await monitor.start();
  await monitor.stop();

  assert.deepEqual(await fs.readdir(path.join(dir, "processing")), []);
  assert.deepEqual(await fs.readdir(path.join(dir, "failed")), ["inj_b.json"]);
});

test("a stale processing job is parked in failed/, not re-run, on recovery", async () => {
  const dir = await tmpInjectDir();
  // Simulate a crash mid-handling: a job left stranded in processing/.
  await fs.mkdir(path.join(dir, "processing"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "processing", "inj_c.json"),
    JSON.stringify({ id: "inj_c", createdAt: new Date().toISOString(), target: "u1", text: "hi", source: "cli" }),
  );

  const seen: string[] = [];
  const monitor = new InjectionMonitor({
    injectDir: dir,
    log: () => {},
    onMessage: async (job) => { seen.push(job.id); },
  });
  await monitor.start();
  await monitor.stop();

  assert.deepEqual(seen, [], "recovered job must NOT be re-executed");
  assert.deepEqual(await fs.readdir(path.join(dir, "failed")), ["inj_c.json"]);
  assert.deepEqual(await fs.readdir(path.join(dir, "processing")), []);
});
