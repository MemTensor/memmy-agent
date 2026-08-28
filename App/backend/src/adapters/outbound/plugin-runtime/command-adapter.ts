/** Sandboxed local command plugin runtime adapter. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  CapabilityEventSchema,
  type CapabilityCall,
  type CapabilityEvent,
  type PluginRuntime
} from "@memmy/local-api-contracts";
import { z } from "zod";
import type { PluginAdapter, PluginRuntimeContext, PluginSession } from "./types.js";

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

const CommandRuntimeConfigSchema = z.object({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  inputMode: z.enum(["stdin-json", "argument-json"]).default("stdin-json"),
  outputMode: z.enum(["json", "ndjson"]).default("json"),
  interactive: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
  secretEnv: z.record(z.string(), z.string().min(1)).default({}),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000),
  maxOutputBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES).default(10 * 1024 * 1024)
});
export type CommandRuntimeConfig = z.infer<typeof CommandRuntimeConfigSchema>;

export interface SandboxLaunch {
  command: string;
  args: string[];
  cwd: string;
}

interface CommandPluginSession extends PluginSession {
  launch: SandboxLaunch;
  config: CommandRuntimeConfig;
  pluginConfig: Readonly<Record<string, unknown>>;
  env: Record<string, string>;
  children: Map<string, ChildProcessWithoutNullStreams>;
}

export interface CreateCommandPluginAdapterOptions {
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
  buildLaunch?: (context: PluginRuntimeContext, config: CommandRuntimeConfig) => Promise<SandboxLaunch>;
}

export function createCommandPluginAdapter(options: CreateCommandPluginAdapterOptions = {}): PluginAdapter {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? spawn;
  const buildLaunch = options.buildLaunch ?? ((context, config) => buildPluginSandboxLaunch(context, config, platform));

  return {
    id: "command",

    validate(runtime, rootPath) {
      validateCommandConfig(runtime, rootPath, platform);
    },

    async activate(context) {
      const config = validateCommandConfig(context.plugin.manifest.runtime, context.rootPath, platform);
      if (context.plugin.manifest.permissions.some((permission) => permission.type === "network")) {
        throw Object.assign(new Error("Command plugins cannot request network access; use HTTP or MCP"), {
          code: "plugin_permission_denied"
        });
      }
      const env = resolvePluginEnvironment(config.env, config.secretEnv, context.secrets);
      return {
        pluginId: context.plugin.id,
        launch: await buildLaunch(context, config),
        config,
        pluginConfig: context.config,
        env,
        children: new Map()
      } satisfies CommandPluginSession;
    },

    async *invoke(rawSession, call) {
      const session = asCommandSession(rawSession);
      const request = JSON.stringify({
        callId: call.callId,
        capabilityId: call.capabilityId,
        conversationId: call.conversationId,
        input: call.input,
        deadline: call.deadline,
        config: session.pluginConfig
      });
      const args = session.launch.args.map((arg) => applyPlaceholders(arg, call));
      if (session.config.inputMode === "argument-json") args.push(request);
      const child = spawnFn(session.launch.command, args, {
        cwd: session.launch.cwd,
        env: session.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
      session.children.set(call.callId, child);
      if (session.config.inputMode === "stdin-json") child.stdin.write(`${request}\n`);
      if (!session.config.interactive) child.stdin.end();

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8", 0, MAX_STDERR_BYTES - stderr.length);
      });
      const exit = processExit(child);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, callTimeoutMs(session.config.timeoutMs, call.deadline));
      try {
        let terminal: CapabilityEvent | null = null;
        let jsonOutput: Buffer | null = null;
        if (session.config.outputMode === "ndjson") {
          let bytes = 0;
          const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
          for await (const line of lines) {
            bytes += Buffer.byteLength(line) + 1;
            if (bytes > session.config.maxOutputBytes) {
              terminate(child);
              throw new Error("Plugin command output exceeded size limit");
            }
            if (line.trim()) {
              const event = CapabilityEventSchema.parse(JSON.parse(line));
              if (event.type === "result" || event.type === "error") {
                if (terminal) throw new Error("Plugin command emitted multiple terminal events");
                terminal = event;
              } else {
                yield event;
              }
            }
          }
        } else {
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of child.stdout) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > session.config.maxOutputBytes) {
              terminate(child);
              throw new Error("Plugin command output exceeded size limit");
            }
            chunks.push(buffer);
          }
          jsonOutput = Buffer.concat(chunks, bytes);
        }
        const { code, signal } = await exit;
        if (timedOut) throw Object.assign(new Error("Plugin command timed out"), { code: "plugin_timeout" });
        if (code !== 0) throw new Error(`Plugin command exited with ${code ?? signal}: ${stderr.trim() || "no stderr"}`);
        if (jsonOutput) {
          const output = JSON.parse(jsonOutput.toString("utf8"));
          if (isCapabilityEvent(output)) terminal = CapabilityEventSchema.parse(output);
          else if (Array.isArray(output?.events)) {
            for (const rawEvent of output.events) {
              const event = CapabilityEventSchema.parse(rawEvent);
              if (event.type === "result" || event.type === "error") {
                if (terminal) throw new Error("Plugin command emitted multiple terminal events");
                terminal = event;
              } else {
                yield event;
              }
            }
          } else terminal = { type: "result", output };
        }
        if (terminal) yield terminal;
      } finally {
        clearTimeout(timer);
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
        session.children.delete(call.callId);
      }
    },

    async respond(rawSession, callId, interactionId, response) {
      const session = asCommandSession(rawSession);
      const child = session.children.get(callId);
      if (!session.config.interactive || !child || child.stdin.destroyed) {
        throw new Error("Plugin command interaction is not available");
      }
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify({ type: "interaction-response", callId, interactionId, response })}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },

    async cancel(rawSession, callId) {
      const child = asCommandSession(rawSession).children.get(callId);
      if (child) {
        terminate(child);
        await waitForTermination(child);
      }
    },

    async deactivate(rawSession) {
      const session = asCommandSession(rawSession);
      const children = [...session.children.values()];
      for (const child of children) terminate(child);
      await Promise.all(children.map(waitForTermination));
      session.children.clear();
    }
  };
}

function validateCommandConfig(runtime: PluginRuntime, rootPath: string | null, platform: NodeJS.Platform): CommandRuntimeConfig {
  if (runtime.adapter !== "command") throw new Error(`Expected command runtime, got ${runtime.adapter}`);
  if (!rootPath) throw new Error("Command plugin requires an installed artifact");
  if (platform !== "darwin" && platform !== "linux") throw new Error(`Command plugins are unsupported on ${platform}`);
  const config = CommandRuntimeConfigSchema.parse(runtime.config ?? {});
  if (isAbsolute(config.command) || config.command.split(/[\\/]/).includes("..")) {
    throw new Error("Plugin command must be relative to its artifact root");
  }
  return config;
}

export async function buildPluginSandboxLaunch(
  context: PluginRuntimeContext,
  config: Pick<CommandRuntimeConfig, "command" | "args" | "cwd">,
  platform: NodeJS.Platform = process.platform
): Promise<SandboxLaunch> {
  const root = await realpath(context.rootPath!);
  const command = await canonicalDescendant(root, resolve(root, config.command));
  const info = await lstat(command);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Plugin command must be a regular file");
  await access(command, fsConstants.X_OK);
  const cwd = await canonicalDescendant(root, resolve(root, config.cwd), true);
  if (!(await lstat(cwd)).isDirectory()) throw new Error("Plugin command cwd must be a directory");
  const filesystem = await filesystemRules(context);

  if (platform === "darwin") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", seatbeltProfile(root, filesystem), "--", command, ...config.args],
      cwd
    };
  }

  const bwrap = await firstExecutable(["/usr/bin/bwrap", "/bin/bwrap"]);
  if (!bwrap) throw new Error("Command plugins require bubblewrap on Linux");
  return { command: bwrap, args: bwrapArgs(root, cwd, command, config.args, filesystem), cwd };
}

interface FilesystemRule {
  path: string;
  writable: boolean;
}

async function filesystemRules(context: PluginRuntimeContext): Promise<FilesystemRule[]> {
  const rules: FilesystemRule[] = [];
  for (const permission of context.plugin.approvedPermissions) {
    if (permission.type !== "filesystem") continue;
    for (const configured of permission.paths) {
      if (!isAbsolute(configured)) throw new Error(`Filesystem permission path must be absolute: ${configured}`);
      const path = await realpath(configured);
      rules.push({ path, writable: permission.access !== "read" });
    }
  }
  return rules;
}

function seatbeltProfile(root: string, filesystem: FilesystemRule[]): string {
  const readPaths = [
    root,
    "/System",
    "/System/Volumes/Preboot/Cryptexes/OS",
    "/Library/Apple",
    "/usr/lib",
    "/usr/libexec",
    "/usr/share",
    "/bin",
    "/usr/bin",
    ...filesystem.map((rule) => rule.path)
  ];
  const writePaths = filesystem.filter((rule) => rule.writable).map((rule) => rule.path);
  const clauses = [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(allow process-exec process-fork)",
    "(allow signal process-info* (target same-sandbox))",
    `(allow file-read-metadata file-test-existence ${readPaths.map(seatbeltAncestors).join(" ")})`,
    `(allow file-map-executable (subpath "/System") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/usr/lib") (subpath "/Library/Apple") ${seatbeltSubpath(root)})`,
    `(allow file-read* ${readPaths.map(seatbeltSubpath).join(" ")})`
  ];
  if (writePaths.length) clauses.push(`(allow file-write* ${writePaths.map(seatbeltSubpath).join(" ")})`);
  return clauses.join("\n");
}

function seatbeltSubpath(path: string): string {
  return `(subpath ${JSON.stringify(path)})`;
}

function seatbeltAncestors(path: string): string {
  return `(path-ancestors ${JSON.stringify(path)})`;
}

function bwrapArgs(
  root: string,
  cwd: string,
  command: string,
  commandArgs: string[],
  filesystem: FilesystemRule[]
): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  const bindTargets = [root, ...filesystem.map((rule) => rule.path)];
  for (const directory of new Set(bindTargets.flatMap(parentDirectories))) args.push("--dir", directory);
  for (const path of ["/usr", "/bin", "/lib", "/lib64"]) args.push("--ro-bind-try", path, path);
  args.push("--ro-bind", root, root);
  for (const rule of filesystem) args.push(rule.writable ? "--bind" : "--ro-bind", rule.path, rule.path);
  args.push("--chdir", cwd, "--", command, ...commandArgs);
  return args;
}

function parentDirectories(path: string): string[] {
  const parts = resolve(path).split(sep).filter(Boolean);
  const directories: string[] = [];
  let current: string = sep;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    if (!["/usr", "/bin", "/lib", "/lib64"].includes(current)) directories.push(current);
  }
  return directories;
}

async function canonicalDescendant(root: string, path: string, allowRoot = false): Promise<string> {
  const canonical = await realpath(path);
  const child = relative(root, canonical);
  if ((!allowRoot && !child) || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Plugin command path escapes its artifact root");
  }
  return canonical;
}

async function firstExecutable(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path, fsConstants.X_OK);
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolvePluginEnvironment(
  configured: Readonly<Record<string, string>>,
  secretEnv: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>
): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...configured };
  for (const [name, key] of Object.entries(secretEnv)) {
    const value = secrets[key];
    if (!value) throw new Error(`Missing plugin secret for environment variable ${name}`);
    env[name] = value;
  }
  return env;
}

function applyPlaceholders(value: string, call: CapabilityCall): string {
  return value
    .replaceAll("{capabilityId}", call.capabilityId)
    .replaceAll("{callId}", call.callId)
    .replaceAll("{conversationId}", call.conversationId);
}

function processExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5_000);
  timer.unref();
}

function waitForTermination(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_500);
    timer.unref();
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function callTimeoutMs(configured: number, deadline: string | undefined): number {
  if (!deadline) return configured;
  return Math.max(1, Math.min(configured, Date.parse(deadline) - Date.now()));
}

function isCapabilityEvent(value: unknown): value is CapabilityEvent {
  return Boolean(value && typeof value === "object" && "type" in value);
}

function asCommandSession(session: PluginSession): CommandPluginSession {
  if (!("children" in session)) throw new Error("Invalid command plugin session");
  return session as CommandPluginSession;
}
