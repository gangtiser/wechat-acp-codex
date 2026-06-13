import fs from "node:fs/promises";
import path from "node:path";
import type { InjectedMessage } from "./types.js";

const POLL_INTERVAL_MS = 2_000;
const INJECT_DIR_MODE = 0o700;

export interface InjectionMonitorOpts {
  injectDir: string;
  log: (msg: string) => void;
  onMessage: (job: InjectedMessage) => Promise<void>;
}

export class InjectionMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private currentProcessing: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly opts: InjectionMonitorOpts) {}

  async start(): Promise<void> {
    await this.ensureDirs();
    await this.recoverProcessing();
    await this.processPending();
    this.timer = setInterval(() => {
      this.processPending().catch((err) => {
        this.opts.log(`[inject] monitor error: ${String(err)}`);
      });
    }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.currentProcessing;
  }

  private async processPending(): Promise<void> {
    if (this.processing) {
      await this.currentProcessing;
      return;
    }
    if (this.stopped) return;
    this.processing = true;
    this.currentProcessing = this.drainPending();
    try {
      await this.currentProcessing;
    } finally {
      this.processing = false;
      this.currentProcessing = null;
    }
  }

  private async drainPending(): Promise<void> {
    try {
      const pendingDir = this.dir("pending");
      const files = (await fs.readdir(pendingDir).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }))
        .filter((name) => name.endsWith(".json"))
        .sort();

      for (const file of files) {
        if (this.stopped) break;
        await this.processFile(file);
      }
    } catch (err) {
      throw err;
    }
  }

  private async processFile(file: string): Promise<void> {
    const pendingPath = path.join(this.dir("pending"), file);
    const processingPath = path.join(this.dir("processing"), file);

    try {
      await fs.rename(pendingPath, processingPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }

    try {
      const job = await this.readJob(processingPath);
      await this.opts.onMessage(job);
      // Done — drop the file. Inject jobs are at-least-once with no dedup, so
      // there is no replay credential to retain; keeping them would grow the
      // dir unbounded under cron/automation use.
      await fs.rm(processingPath, { force: true });
      this.opts.log(`[inject] processed ${job.id} for ${job.target}`);
    } catch (err) {
      const failedPath = path.join(this.dir("failed"), file);
      const raw = await fs.readFile(processingPath, "utf-8").catch(() => "");
      const failure = {
        failedAt: new Date().toISOString(),
        error: String(err),
        raw,
      };
      await fs.writeFile(
        processingPath,
        JSON.stringify(failure, null, 2) + "\n",
        "utf-8",
      ).catch((e) => this.opts.log(`[inject] could not write failure for ${file}: ${String(e)}`));
      await fs.rename(processingPath, failedPath).catch((e) =>
        this.opts.log(`[inject] could not move ${file} to failed/ (left in processing/): ${String(e)}`),
      );
      this.opts.log(`[inject] failed ${file}: ${String(err)}`);
    }
  }

  private async readJob(filePath: string): Promise<InjectedMessage> {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as Partial<InjectedMessage>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.target !== "string" ||
      typeof parsed.text !== "string" ||
      parsed.source !== "cli" ||
      (parsed.contextToken !== undefined && typeof parsed.contextToken !== "string")
    ) {
      throw new Error(`Invalid injected message file: ${filePath}`);
    }
    return parsed as InjectedMessage;
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.opts.injectDir, { recursive: true, mode: INJECT_DIR_MODE });
    await fs.chmod(this.opts.injectDir, INJECT_DIR_MODE).catch(() => {});

    const dirs = [
      this.dir("pending"),
      this.dir("processing"),
      this.dir("failed"),
    ];
    await Promise.all(dirs.map(async (dir) => {
      await fs.mkdir(dir, { recursive: true, mode: INJECT_DIR_MODE });
      await fs.chmod(dir, INJECT_DIR_MODE).catch(() => {});
    }));
  }

  private async recoverProcessing(): Promise<void> {
    const processingDir = this.dir("processing");
    const files = (await fs.readdir(processingDir).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }))
      .filter((name) => name.endsWith(".json"))
      .sort();

    for (const file of files) {
      const from = path.join(processingDir, file);
      // A file stranded in processing/ crashed mid-handling: we cannot tell
      // whether onMessage already ran (its side effects landed) or not, and
      // inject has no dedup. Re-queueing would risk executing the job twice, so
      // park it in failed/ for inspection instead of silently re-running it.
      const to = path.join(this.dir("failed"), file);
      await fs.rename(from, to).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
      this.opts.log(`[inject] stale processing job ${file} parked in failed/ (not auto-retried to avoid double execution)`);
    }
  }

  private dir(name: "pending" | "processing" | "failed"): string {
    return path.join(this.opts.injectDir, name);
  }
}
