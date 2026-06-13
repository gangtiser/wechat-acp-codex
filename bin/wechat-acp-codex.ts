#!/usr/bin/env node

/**
 * wechat-acp-codex CLI entry point.
 *
 * Usage:
 *   wechat-acp-codex --agent "claude code"
 *   wechat-acp-codex --agent "gemini" --cwd /path/to/project
 *   wechat-acp-codex --agent "npx tsx ./agent.ts" --login
 *   wechat-acp-codex --agent "claude code" --daemon
 *   wechat-acp-codex stop
 *   wechat-acp-codex status
 *   wechat-acp-codex inject --text "今日 AI 资讯"
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";
import { WeChatAcpBridge } from "../src/bridge.js";
import {
  defaultConfig,
  defaultStorageDir,
  listBuiltInAgents,
  resolveAgentSelection,
  resolveCliAgentSelection,
  validateCommandAliases,
  validateInstanceName,
} from "../src/config.js";
import type { WeChatAcpConfig } from "../src/config.js";
import { runOwnerCommand } from "../src/storage/owner.js";
import { queueInjectedMessage } from "../src/inject/queue.js";
import { DEFAULT_INJECTION_TARGET } from "../src/inject/types.js";
import {
  initTelemetry,
  trackEvent,
  trackException,
  shutdownTelemetry,
} from "../src/telemetry/index.js";
import { acquireLock, releaseLock, isAlive, isOurProcess } from "../src/lock.js";
import packageJson from "../package.json" with { type: "json" };

function usage(): void {
  const presets = listBuiltInAgents()
    .map(({ id }) => id)
    .join(", ");

  console.log(`
wechat-acp-codex v${packageJson.version} — Bridge WeChat to any ACP-compatible AI agent

Usage:
  wechat-acp-codex --agent <preset|command>  [options]
  wechat-acp-codex agents                        List built-in agent presets
  wechat-acp-codex inject --text <text>          Inject a local message into the daemon
  wechat-acp-codex owner show                    Show currently bound owner WeChat user id
  wechat-acp-codex owner clear                   Remove bound owner (accept anyone again)
  wechat-acp-codex stop                          Stop a running daemon
  wechat-acp-codex status                        Check daemon status

Options:
  --agent <value>     Built-in preset name or raw agent command
                      Presets: ${presets}
                      Examples: "copilot", "claude", "npx tsx ./agent.ts"
  --cwd <dir>         Working directory for agent (default: current dir)
  --login             Force re-login (new QR code). Does NOT clear the owner.
  --daemon            Run in background after login
  --config <file>     Config file path (JSON)
  --instance <name>   Run as a named, isolated instance.
                      Storage, token, daemon pid/log, and telemetry id are
                      scoped to ~/.wechat-acp-codex/instances/<name>/.
                      Lets you run multiple bridges side by side, each with
                      its own WeChat account and project cwd.
  --owner <user-id>   Bind this WeChat user id as the owner on startup.
                      Messages from any other sender are silently ignored.
  --allow-first       Bind the first sender that messages the bot as the owner.
                      Subsequent senders are blocked until owner is cleared.
  --inbox-dir <path>  Directory to save binary files received from WeChat
                      (default: <storage.dir>/inbox). The agent sees the
                      saved absolute path in the prompt so it can read the
                      file directly.
  --no-inbox          Disable saving received files. The agent will only
                      see a "[Received file: name, N bytes]" notice and
                      will not be able to read the file content.
  --idle-timeout <m>  Session idle timeout in minutes (default: 1440)
                      Use 0 to disable idle cleanup
  --max-sessions <n>  Max concurrent user sessions (default: 10)
  --show-thoughts     Forward agent thinking to WeChat (default: hidden)
  --hide-thoughts     Do not forward agent thinking to WeChat (overrides config)
  --show-diffs        Forward ACP file diffs to WeChat (default: hidden)
  --no-strip-markdown Do not strip markdown from agent replies (default: stripped)
  --text <text>       Message text for "inject"
  --file <path>       Read injected message text from a file
  --to <target>       Injection target (default: ${DEFAULT_INJECTION_TARGET})
  --context-token <t> Override stored context token for "inject"
  -v, --verbose       Verbose logging
  -V, --version       Print version and exit
  -h, --help          Show this help
`);
}

async function handleInject(
  config: WeChatAcpConfig,
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  if (!config.storage.injectDir) {
    throw new Error("storage.injectDir is not configured");
  }
  if (!args.injectText && !args.injectFile) {
    throw new Error('inject requires --text <text> or --file <path>');
  }
  if (args.injectText && args.injectFile) {
    throw new Error("inject accepts only one of --text or --file");
  }

  const text = args.injectFile
    ? fs.readFileSync(path.resolve(args.injectFile), "utf-8")
    : args.injectText!;

  const { job, filePath } = await queueInjectedMessage({
    injectDir: config.storage.injectDir,
    text,
    target: args.injectTo,
    contextToken: args.injectContextToken,
  });

  console.log(`Queued injection ${job.id}`);
  console.log(`Target: ${job.target}`);
  console.log(`File: ${filePath}`);
  console.log("It will be processed by any running wechat-acp-codex instance using the same storage directory.");
}

function parseArgs(argv: string[]): {
  command?: string;
  agent?: string;
  cwd?: string;
  forceLogin: boolean;
  daemon: boolean;
  configFile?: string;
  instance?: string;
  inboxDir?: string;
  disableInbox: boolean;
  idleTimeout?: number;
  maxSessions?: number;
  injectText?: string;
  injectFile?: string;
  injectTo?: string;
  injectContextToken?: string;
  showThoughts: boolean;
  hideThoughts: boolean;
  showDiffs: boolean;
  stripMarkdown?: boolean;
  verbose: boolean;
  version: boolean;
  help: boolean;
  owner?: string;
  allowFirst: boolean;
  ownerAction?: string;
} {
  const result = {
    forceLogin: false,
    daemon: false,
    disableInbox: false,
    showThoughts: false,
    hideThoughts: false,
    showDiffs: false,
    verbose: false,
    version: false,
    help: false,
    allowFirst: false,
  } as ReturnType<typeof parseArgs>;

  const args = argv.slice(2);
  let i = 0;

  // Check for subcommand
  if (args[0] && !args[0].startsWith("-")) {
    result.command = args[0];
    i = 1;
  }

  if (result.command === "owner" && args[1] && !args[1].startsWith("-")) {
    result.ownerAction = args[1];
    i = 2;
  }

  // Consume the value token for a flag, rejecting a missing value (flag at the
  // end of argv) or a value that is actually the next flag (e.g. `--agent
  // --daemon` would otherwise silently swallow --daemon and disable it). Pass
  // { allowDash: true } for free-form values that may legitimately begin "-".
  const takeValue = (flag: string, opts?: { allowDash?: boolean }): string => {
    const v: string | undefined = args[++i];
    if (v === undefined || (!opts?.allowDash && v.startsWith("-"))) {
      console.error(`Error: ${flag} requires a value`);
      process.exit(1);
    }
    return v;
  };

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--agent":
        result.agent = takeValue("--agent");
        break;
      case "--cwd":
        result.cwd = takeValue("--cwd");
        break;
      case "--login":
        result.forceLogin = true;
        break;
      case "--daemon":
        result.daemon = true;
        break;
      case "--config":
        result.configFile = takeValue("--config");
        break;
      case "--instance":
        result.instance = takeValue("--instance");
        break;
      case "--inbox-dir":
        result.inboxDir = takeValue("--inbox-dir");
        break;
      case "--no-inbox":
        result.disableInbox = true;
        break;
      case "--idle-timeout":
        result.idleTimeout = parseInt(takeValue("--idle-timeout"), 10);
        break;
      case "--max-sessions":
        result.maxSessions = parseInt(takeValue("--max-sessions"), 10);
        break;
      case "--show-thoughts":
        result.showThoughts = true;
        break;
      case "--text":
        result.injectText = takeValue("--text", { allowDash: true });
        break;
      case "--file":
        result.injectFile = takeValue("--file");
        break;
      case "--to":
        result.injectTo = takeValue("--to");
        break;
      case "--context-token":
        result.injectContextToken = takeValue("--context-token");
        break;
      case "--hide-thoughts":
        result.hideThoughts = true;
        break;
      case "--show-diffs":
        result.showDiffs = true;
        break;
      case "--no-strip-markdown":
        result.stripMarkdown = false;
        break;
      case "--owner":
        result.owner = takeValue("--owner");
        break;
      case "--allow-first":
        result.allowFirst = true;
        break;
      case "-v":
      case "--verbose":
        result.verbose = true;
        break;
      case "-V":
      case "--version":
        result.version = true;
        break;
      case "-h":
      case "--help":
        result.help = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
    i++;
  }

  return result;
}

function loadConfigFile(filePath: string): Partial<WeChatAcpConfig> {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as Partial<WeChatAcpConfig>;
}

function handleAgents(config: WeChatAcpConfig): void {
  console.log("Built-in ACP agent presets:\n");
  for (const { id, preset } of listBuiltInAgents(config.agents)) {
    const commandLine = [preset.command, ...preset.args].join(" ");
    console.log(`${id.padEnd(10)} ${commandLine}`);
    if (preset.description) {
      console.log(`           ${preset.description}`);
    }
  }
}

function handleStop(config: WeChatAcpConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log("No daemon running (no PID file found)");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (!isAlive(pid)) {
    fs.unlinkSync(pidFile);
    console.log(`Daemon not running (stale PID ${pid}), cleaned up`);
    return;
  }
  // The pid may have been reused by an unrelated process since the daemon
  // died — same rule as lock takeover: never kill what we can't verify.
  if (!isOurProcess(pid)) {
    console.error(
      `Refusing to stop: PID ${pid} is not a verifiable wechat-acp-codex process (PID reuse?). ` +
        `If the daemon is gone, remove ${pidFile} manually.`,
    );
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(pidFile);
    console.log(`Stopped daemon (PID ${pid})`);
  } catch (err) {
    console.error(`Failed to stop daemon: ${String(err)}`);
  }
}

function handleStatus(config: WeChatAcpConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log("Not running");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0); // test if process exists
    console.log(`Running (PID ${pid})`);
  } catch {
    console.log(`Not running (stale PID ${pid})`);
    fs.unlinkSync(pidFile);
  }
}

const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

function daemonize(config: WeChatAcpConfig): void {
  const logFile = config.daemon.logFile;
  const pidFile = config.daemon.pidFile;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  // Best-effort startup rotation so an append-only daemon log can't grow
  // without bound across restarts (keeps one .old generation).
  try {
    if (fs.statSync(logFile).size > LOG_ROTATE_BYTES) {
      fs.renameSync(logFile, `${logFile}.old`);
    }
  } catch {
    // no log yet, or rotation blocked (e.g. Windows rename-over-existing)
  }

  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  // Re-run ourselves detached, with --daemon stripped and WECHAT_CODEX_DAEMON=1
  // set so the child runs the bridge in the foreground.
  const args = process.argv.slice(1).filter((a) => a !== "--daemon");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, WECHAT_CODEX_DAEMON: "1" },
    windowsHide: true,
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf-8");
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Logs: ${logFile}`);
  console.log(`PID file: ${pidFile}`);
  process.exit(0);
}

function renderQrInTerminal(url: string): void {
  qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
    console.log(qr);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.version) {
    console.log(packageJson.version);
    process.exit(0);
  }

  if (args.help) {
    usage();
    process.exit(0);
  }

  if (args.instance !== undefined) {
    try {
      validateInstanceName(args.instance);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const config = defaultConfig({ instance: args.instance });

  // Load config file if specified
  let configFileSetInboxDir = false;
  let configFileSetStateFile = false;
  let configFileSetInjectDir = false;
  if (args.configFile) {
    const fileConfig = loadConfigFile(args.configFile);
    Object.assign(config.wechat, fileConfig.wechat ?? {});
    Object.assign(config.agent, fileConfig.agent ?? {});
    Object.assign(config.agents, fileConfig.agents ?? {});
    Object.assign(config.session, fileConfig.session ?? {});
    Object.assign(config.daemon, fileConfig.daemon ?? {});
    if (Object.prototype.hasOwnProperty.call(fileConfig, "commandAliases")) {
      // Assign the raw value (even if malformed) so the post-merge
      // validateCommandAliases() below can reject it with a clean error.
      config.commandAliases = fileConfig.commandAliases;
    }
    // Track whether the user explicitly set inboxDir so we don't
    // overwrite their choice with a re-derived default below. We check
    // before Object.assign because checking after can't distinguish
    // "user wrote inboxDir: null to disable" from "user didn't write it".
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "inboxDir")
    ) {
      configFileSetInboxDir = true;
    }
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "stateFile")
    ) {
      configFileSetStateFile = true;
    }
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "injectDir")
    ) {
      configFileSetInjectDir = true;
    }
    Object.assign(config.storage, fileConfig.storage ?? {});
  }

  // CLI --instance always wins over config-file storage.dir so users can
  // run a config in multiple isolated instances without editing the file.
  if (args.instance) {
    config.storage.instance = args.instance;
    config.storage.dir = defaultStorageDir(args.instance);
    config.daemon.logFile = path.join(config.storage.dir, "wechat-acp-codex.log");
    config.daemon.pidFile = path.join(config.storage.dir, "daemon.pid");
  }

  // Resolve the final inbox directory. Precedence (highest first):
  //   1. --no-inbox            (explicit disable)
  //   2. --inbox-dir <path>    (explicit CLI override)
  //   3. config.storage.inboxDir explicitly set in the config file
  //      (relative paths are resolved against cwd)
  //   4. Default: <storage.dir>/inbox, re-derived from whatever the
  //      final storage.dir is. This is what keeps a config file that
  //      only sets storage.dir consistent with the documented
  //      "default: <storage.dir>/inbox", and also covers the
  //      --instance case for free.
  if (args.disableInbox) {
    config.storage.inboxDir = null;
  } else if (args.inboxDir) {
    config.storage.inboxDir = path.resolve(args.inboxDir);
  } else if (configFileSetInboxDir) {
    if (config.storage.inboxDir && !path.isAbsolute(config.storage.inboxDir)) {
      config.storage.inboxDir = path.resolve(config.storage.inboxDir);
    }
  } else {
    config.storage.inboxDir = path.join(config.storage.dir, "inbox");
  }

  if (configFileSetStateFile) {
    if (config.storage.stateFile && !path.isAbsolute(config.storage.stateFile)) {
      config.storage.stateFile = path.resolve(config.storage.stateFile);
    }
  } else {
    config.storage.stateFile = path.join(config.storage.dir, "state.json");
  }

  if (configFileSetInjectDir) {
    if (config.storage.injectDir && !path.isAbsolute(config.storage.injectDir)) {
      config.storage.injectDir = path.resolve(config.storage.injectDir);
    }
  } else {
    config.storage.injectDir = path.join(config.storage.dir, "inject");
  }

  try {
    validateCommandAliases(config.commandAliases);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  // Handle subcommands
  if (args.command === "agents") {
    handleAgents(config);
    return;
  }
  if (args.command === "inject") {
    await handleInject(config, args);
    return;
  }
  if (args.command === "stop") {
    handleStop(config);
    return;
  }
  if (args.command === "status") {
    handleStatus(config);
    return;
  }
  if (args.command === "owner") {
    process.exit(runOwnerCommand(config.storage.dir, args.ownerAction, (m) => console.log(m)));
  }

  const agentSelection = resolveCliAgentSelection({
    argAgent: args.agent,
    configPreset: config.agent.preset,
    configCommand: config.agent.command,
    defaultPreset: "codex",
  });

  // With a default preset this should never trigger, but keep it as a guard
  // for the (impossible) case of no selection and no raw command.
  if (!agentSelection && !config.agent.command) {
    console.error("Error: no agent configured\n");
    usage();
    process.exit(1);
  }

  if (agentSelection) {
    const resolvedAgent = resolveAgentSelection(agentSelection, config.agents);
    config.agent.preset = resolvedAgent.id;
    config.agent.command = resolvedAgent.command;
    config.agent.args = resolvedAgent.args;
    if (resolvedAgent.env) {
      config.agent.env = { ...(config.agent.env ?? {}), ...resolvedAgent.env };
    }
  }

  if (args.cwd) config.agent.cwd = path.resolve(args.cwd);
  if (args.idleTimeout !== undefined) {
    if (!Number.isFinite(args.idleTimeout) || args.idleTimeout < 0) {
      console.error("Error: invalid --idle-timeout value");
      console.error('Use a non-negative integer minute value, where "0" means unlimited.');
      process.exit(1);
    }
    config.session.idleTimeoutMs = args.idleTimeout * 60_000;
  }
  if (args.maxSessions !== undefined) {
    if (!Number.isInteger(args.maxSessions) || args.maxSessions < 1) {
      console.error("Error: invalid --max-sessions value");
      console.error("Use a positive integer (at least 1).");
      process.exit(1);
    }
    config.session.maxConcurrentUsers = args.maxSessions;
  }
  if (args.showThoughts) config.agent.showThoughts = true;
  if (args.hideThoughts) config.agent.showThoughts = false;
  if (args.showDiffs) config.agent.showDiffs = true;
  if (args.stripMarkdown === false) config.agent.stripMarkdown = false;
  config.daemon.enabled = args.daemon;
  if (args.owner !== undefined) config.owner = { ...(config.owner ?? {}), id: args.owner };
  if (args.allowFirst) config.owner = { ...(config.owner ?? {}), allowFirst: true };

  // Handle daemon mode
  if (args.daemon && !process.env.WECHAT_CODEX_DAEMON) {
    daemonize(config);
    return;
  }

  // Acquire single-instance lock (only the actual bridge process reaches here).
  const lockPath = path.join(config.storage.dir, "wechat.lock");
  const locked = await acquireLock({
    lockPath,
    storageDir: config.storage.dir,
    instance: config.storage.instance,
    log: (m) => console.error(m),
  });
  if (!locked) process.exit(1);
  process.on("exit", () => releaseLock(lockPath));

  // Telemetry was removed in wechat-acp-codex; initTelemetry is an unconditional no-op.
  initTelemetry({
    version: packageJson.version,
    storageDir: config.storage.dir,
    agentPreset: config.agent.preset ?? "raw",
    daemon: config.daemon.enabled,
  });
  trackEvent("app.start", {
    agentPreset: config.agent.preset ?? "raw",
    daemon: config.daemon.enabled,
  });
  const startedAt = Date.now();

  // Create and start bridge
  const bridge = new WeChatAcpBridge(config, (msg) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${msg}`);
  });

  // Handle graceful shutdown
  const shutdown = async (reason: "signal" | "error" | "normal") => {
    trackEvent("app.stop", { reason, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    await bridge.stop();
    releaseLock(lockPath);
    await shutdownTelemetry();
    process.exit(reason === "error" ? 1 : 0);
  };
  process.on("SIGINT", () => void shutdown("signal"));
  process.on("SIGTERM", () => void shutdown("signal"));

  try {
    await bridge.start({
      forceLogin: args.forceLogin,
      renderQrUrl: renderQrInTerminal,
    });
  } catch (err) {
    if ((err as Error).message === "aborted") {
      // Normal shutdown
    } else {
      trackException(err, "main");
      trackEvent("app.stop", { reason: "error", uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
      await shutdownTelemetry();
      console.error(`Fatal: ${String(err)}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
