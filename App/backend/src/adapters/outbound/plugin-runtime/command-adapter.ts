/** Sandboxed local command plugin runtime adapter. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  CapabilityEventSchema,
  PluginHostServiceRequestSchema,
  type CapabilityCall,
  type CapabilityEvent,
  type PluginHostServiceRequest,
  type PluginHostServiceResponse,
  type PluginRuntime
} from "@memmy/local-api-contracts";
import { z } from "zod";
import { callTimeoutMs, isCapabilityEvent } from "./shared.js";
import type { PluginAdapter, PluginHostServiceInvoker, PluginRuntimeContext, PluginSession } from "./types.js";

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_HOST_SERVICE_REQUESTS_PER_CALL = 16;
const CommandRuntimeDependencySchema = z.enum(["texlive"]);

const CommandRuntimeConfigSchema = z.object({
  command: z.string().trim().min(1),
  interpreter: z.enum(["direct", "node"]).default("direct"),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  inputMode: z.enum(["stdin-json", "argument-json"]).default("stdin-json"),
  outputMode: z.enum(["json", "ndjson"]).default("json"),
  interactive: z.boolean().default(false),
  runtimeDependencies: z.array(CommandRuntimeDependencySchema).max(8).default([]),
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
  hostServiceControllers: Map<string, Set<AbortController>>;
  approvedHostServices: Set<string>;
}

export interface CreateCommandPluginAdapterOptions {
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
  buildLaunch?: (
    context: PluginRuntimeContext,
    config: CommandRuntimeConfig,
    networkEnabled: boolean,
    runtimeDependencies: ResolvedCommandRuntimeDependencies
  ) => Promise<SandboxLaunch>;
  /** Exact DNS hosts local command plugins may request in their manifest. */
  allowedNetworkHosts?: readonly string[];
  /** Host-owned upload roots made readable only to plugins approved for the file-input host service. */
  fileInputRoots?: readonly string[];
  /** Host-owned parent directory containing one writable data directory per plugin. */
  pluginDataRoot?: string;
  /** Host-owned services callable over the private command runtime protocol. */
  hostServices?: PluginHostServiceInvoker;
}

export function createCommandPluginAdapter(options: CreateCommandPluginAdapterOptions = {}): PluginAdapter {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? spawn;
  const buildLaunch = options.buildLaunch ?? ((context, config, networkEnabled, runtimeDependencies) => buildPluginSandboxLaunch(
    context,
    config,
    platform,
    networkEnabled,
    options.fileInputRoots ?? [],
    options.pluginDataRoot,
    runtimeDependencies.readRoots,
    runtimeDependencies.executableRoots
  ));
  const allowedNetworkHosts = new Set((options.allowedNetworkHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean));

  return {
    id: "command",

    validate(runtime, rootPath) {
      validateCommandConfig(runtime, rootPath, platform);
    },

    async activate(context) {
      const config = validateCommandConfig(context.plugin.manifest.runtime, context.rootPath, platform);
      const requestedNetworkHosts = context.plugin.manifest.permissions
        .filter((permission) => permission.type === "network")
        .flatMap((permission) => permission.hosts);
      const deniedHost = requestedNetworkHosts.find((host) => !allowedNetworkHosts.has(host));
      if (deniedHost) throw Object.assign(new Error(`Command plugin network host is not in the host allowlist: ${deniedHost}`), {
        code: "plugin_permission_denied"
      });
      const runtimeDependencies = await resolveCommandRuntimeDependencies(config.runtimeDependencies, platform);
      const env = resolvePluginEnvironment(
        config.env,
        config.secretEnv,
        context.secrets,
        runtimeDependencies.pathEntries,
        runtimeDependencies.environment
      );
      // In packaged and Electron-hosted development builds, process.execPath is
      // the Electron executable.  `interpreter: "node"` intentionally reuses
      // that trusted Host runtime, so the child must opt into Electron's Node
      // compatibility mode.  The variable is harmless when process.execPath is
      // already a standalone Node binary.
      if (config.interpreter === "node") env.ELECTRON_RUN_AS_NODE = "1";
      const pluginDataPath = await resolvePluginDataPath(context, options.pluginDataRoot);
      if (pluginDataPath) env.MEMMY_PLUGIN_DATA_DIR = pluginDataPath;
      return {
        pluginId: context.plugin.id,
        launch: await buildLaunch(context, config, requestedNetworkHosts.length > 0, runtimeDependencies),
        config,
        pluginConfig: context.config,
        env,
        children: new Map(),
        hostServiceControllers: new Map(),
        approvedHostServices: new Set(context.plugin.approvedPermissions
          .filter((permission) => permission.type === "host-service")
          .flatMap((permission) => permission.services))
      } satisfies CommandPluginSession;
    },

    async *invoke(rawSession, call) {
      const session = asCommandSession(rawSession);
      const request = JSON.stringify({
        callId: call.callId,
        pluginId: call.pluginId,
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
      child.once("close", () => abortHostServices(session, call.callId));
      if (session.config.inputMode === "stdin-json") child.stdin.write(`${request}\n`);
      if (!session.config.interactive) child.stdin.end();

      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8", 0, MAX_STDERR_BYTES - stderr.length);
      });
      const exit = processExit(child);
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, callTimeoutMs(session.config.timeoutMs, call.deadline));
      try {
        let terminal: CapabilityEvent | null = null;
        let jsonOutput: Buffer | null = null;
        if (session.config.outputMode === "ndjson") {
          let bytes = 0;
          let hostServiceRequests = 0;
          const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
          for await (const line of lines) {
            bytes += Buffer.byteLength(line) + 1;
            if (bytes > session.config.maxOutputBytes) {
              terminate(child);
              throw new Error("Plugin command output exceeded size limit");
            }
            if (line.trim()) {
              const raw = JSON.parse(line);
              const hostRequest = PluginHostServiceRequestSchema.safeParse(raw);
              if (hostRequest.success) {
                hostServiceRequests += 1;
                await respondToHostServiceRequest(child, session, call, hostRequest.data, options.hostServices, hostServiceRequests);
                continue;
              }
              const event = CapabilityEventSchema.parse(raw);
              if (event.type === "result" || event.type === "error") {
                if (terminal) throw new Error("Plugin command emitted multiple terminal events");
                terminal = event;
              } else {
                // Once an interactive card is visible, user think time must not
                // consume the command execution budget. Explicit cancellation,
                // app shutdown, and the outer Agent request still stop the run.
                if (event.type === "interaction" && timer) {
                  clearTimeout(timer);
                  timer = undefined;
                }
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
        if (timer) clearTimeout(timer);
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
      const session = asCommandSession(rawSession);
      abortHostServices(session, callId);
      const child = session.children.get(callId);
      if (child) {
        terminate(child);
        await waitForTermination(child);
      }
    },

    async deactivate(rawSession) {
      const session = asCommandSession(rawSession);
      const children = [...session.children.values()];
      for (const callId of session.children.keys()) abortHostServices(session, callId);
      for (const child of children) terminate(child);
      await Promise.all(children.map(waitForTermination));
      session.children.clear();
    }
  };
}

async function respondToHostServiceRequest(
  child: ChildProcessWithoutNullStreams,
  session: CommandPluginSession,
  call: CapabilityCall,
  request: PluginHostServiceRequest,
  invoker: PluginHostServiceInvoker | undefined,
  requestNumber: number
): Promise<void> {
  let message: PluginHostServiceResponse;
  if (requestNumber > MAX_HOST_SERVICE_REQUESTS_PER_CALL) {
    message = hostServiceError(call.callId, request.requestId, "host_service_limit_exceeded", `A plugin call may make at most ${MAX_HOST_SERVICE_REQUESTS_PER_CALL} Host-service requests`, false);
  } else if (!session.config.interactive) {
    message = hostServiceError(call.callId, request.requestId, "plugin_runtime_error", "Host services require an interactive command runtime", false);
  } else if (!session.approvedHostServices.has(request.service)) {
    message = hostServiceError(call.callId, request.requestId, "plugin_permission_denied", `Host service permission was not approved: ${request.service}`, false);
  } else if (!invoker) {
    message = hostServiceError(call.callId, request.requestId, "host_service_unavailable", `Host service is unavailable: ${request.service}`, true);
  } else {
    const controller = new AbortController();
    const controllers = session.hostServiceControllers.get(call.callId) ?? new Set<AbortController>();
    controllers.add(controller);
    session.hostServiceControllers.set(call.callId, controllers);
    try {
      const response = await invoker.invoke({
        pluginId: session.pluginId,
        callId: call.callId,
        conversationId: call.conversationId,
        service: request.service,
        input: request.input,
        deadline: call.deadline,
        signal: controller.signal
      });
      message = { type: "host-service-response", callId: call.callId, requestId: request.requestId, response };
    } catch (error) {
      const details = error as { code?: unknown; retryable?: unknown; message?: unknown };
      message = hostServiceError(
        call.callId,
        request.requestId,
        typeof details.code === "string" ? details.code : "host_service_error",
        typeof details.message === "string" ? details.message : "Host service request failed",
        details.retryable === true
      );
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) session.hostServiceControllers.delete(call.callId);
    }
  }
  await writeChildMessage(child, message);
}

function abortHostServices(session: CommandPluginSession, callId: string): void {
  const controllers = session.hostServiceControllers.get(callId);
  if (!controllers) return;
  session.hostServiceControllers.delete(callId);
  for (const controller of controllers) controller.abort(new Error("plugin_call_cancelled"));
}

function hostServiceError(callId: string, requestId: string, code: string, message: string, retryable: boolean): PluginHostServiceResponse {
  return { type: "host-service-response", callId, requestId, error: { code, message, retryable } };
}

async function writeChildMessage(child: ChildProcessWithoutNullStreams, message: PluginHostServiceResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
  });
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
  config: Pick<CommandRuntimeConfig, "command" | "args" | "cwd"> & Partial<Pick<CommandRuntimeConfig, "interpreter">>,
  platform: NodeJS.Platform = process.platform,
  networkEnabled = false,
  fileInputRoots: readonly string[] = [],
  pluginDataRoot?: string,
  runtimeReadRoots: readonly string[] = [],
  runtimeExecutableRoots: readonly string[] = []
): Promise<SandboxLaunch> {
  const root = await realpath(context.rootPath!);
  const command = await canonicalDescendant(root, resolve(root, config.command));
  const info = await lstat(command);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Plugin command must be a regular file");
  const interpreter = config.interpreter ?? "direct";
  if (interpreter === "direct") await access(command, fsConstants.X_OK);
  const runtimeCommand = interpreter === "node" ? await realpath(process.execPath) : command;
  const runtimeRoot = interpreter === "node" ? resolve(dirname(runtimeCommand), "..") : null;
  const runtimeArgs = interpreter === "node" ? [command, ...config.args] : config.args;
  const cwd = await canonicalDescendant(root, resolve(root, config.cwd), true);
  if (!(await lstat(cwd)).isDirectory()) throw new Error("Plugin command cwd must be a directory");
  const filesystem = await filesystemRules(context, fileInputRoots, pluginDataRoot);

  if (platform === "darwin") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", seatbeltProfile(root, filesystem, networkEnabled, runtimeRoot, runtimeReadRoots, runtimeExecutableRoots), "--", runtimeCommand, ...runtimeArgs],
      cwd
    };
  }

  const bwrap = await firstExecutable(["/usr/bin/bwrap", "/bin/bwrap"]);
  if (!bwrap) throw new Error("Command plugins require bubblewrap on Linux");
  return { command: bwrap, args: bwrapArgs(root, cwd, runtimeCommand, runtimeArgs, filesystem, networkEnabled, runtimeRoot, runtimeReadRoots), cwd };
}

export interface ResolvedCommandRuntimeDependencies {
  pathEntries: string[];
  readRoots: string[];
  executableRoots: string[];
  environment: Record<string, string>;
}

/** Resolve only Host-approved runtimes; plugin manifests cannot inject arbitrary executable roots. */
export async function resolveCommandRuntimeDependencies(
  dependencies: readonly z.infer<typeof CommandRuntimeDependencySchema>[],
  platform: NodeJS.Platform = process.platform
): Promise<ResolvedCommandRuntimeDependencies> {
  const resolved: ResolvedCommandRuntimeDependencies = { pathEntries: [], readRoots: [], executableRoots: [], environment: {} };
  if (!dependencies.includes("texlive")) return resolved;

  if (platform === "darwin") {
    const binaryRoot = await realpath("/Library/TeX/texbin").catch(() => null);
    const distributionRoot = await realpath("/usr/local/texlive").catch(() => null);
    const userTexmfRoot = await realpath(resolve(homedir(), "Library", "texmf")).catch(() => null);
    if (binaryRoot) resolved.pathEntries.push(binaryRoot);
    if (distributionRoot) {
      resolved.readRoots.push(distributionRoot);
      resolved.executableRoots.push(distributionRoot);
    }
    if (userTexmfRoot) {
      resolved.readRoots.push(userTexmfRoot);
      resolved.environment.TEXMFHOME = userTexmfRoot;
    }
  }
  return resolved;
}

interface FilesystemRule {
  path: string;
  writable: boolean;
}

async function filesystemRules(
  context: PluginRuntimeContext,
  fileInputRoots: readonly string[],
  pluginDataRoot?: string
): Promise<FilesystemRule[]> {
  const rules: FilesystemRule[] = [];
  for (const permission of context.plugin.approvedPermissions) {
    if (permission.type !== "filesystem") continue;
    for (const configured of permission.paths) {
      if (!isAbsolute(configured)) throw new Error(`Filesystem permission path must be absolute: ${configured}`);
      const path = await realpath(configured);
      rules.push({ path, writable: permission.access !== "read" });
    }
  }
  if (approvedHostService(context, "file-input")) {
    for (const configured of fileInputRoots) {
      if (!isAbsolute(configured)) throw new Error(`File-input root must be absolute: ${configured}`);
      const path = await realpath(configured).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (path) rules.push({ path, writable: false });
    }
  }
  const pluginDataPath = await resolvePluginDataPath(context, pluginDataRoot);
  if (pluginDataPath) {
    rules.push({ path: pluginDataPath, writable: true });
  }
  return rules;
}

function approvedHostService(context: PluginRuntimeContext, service: string): boolean {
  return context.plugin.approvedPermissions.some((permission) => permission.type === "host-service" && permission.services.includes(service));
}

async function resolvePluginDataPath(context: PluginRuntimeContext, configuredRoot: string | undefined): Promise<string | null> {
  if (!approvedHostService(context, "plugin-data")) return null;
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new Error("plugin-data host service requires a Host-owned absolute data root");
  }
  await mkdir(configuredRoot, { recursive: true });
  const root = await realpath(configuredRoot);
  const target = resolve(root, context.plugin.id);
  const child = relative(root, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Plugin data path escapes the Host-owned data root");
  }
  await mkdir(target, { recursive: true });
  return realpath(target);
}

function seatbeltProfile(
  root: string,
  filesystem: FilesystemRule[],
  networkEnabled: boolean,
  runtimeRoot: string | null,
  runtimeReadRoots: readonly string[],
  runtimeExecutableRoots: readonly string[]
): string {
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
    ...filesystem.map((rule) => rule.path),
    ...(runtimeRoot ? [runtimeRoot] : []),
    ...runtimeReadRoots
  ];
  const writePaths = filesystem.filter((rule) => rule.writable).map((rule) => rule.path);
  const clauses = [
    "(version 1)",
    "(deny default)",
    "(import \"system.sb\")",
    "(allow process-exec process-fork)",
    "(allow signal process-info* (target same-sandbox))",
    `(allow file-read-metadata file-test-existence ${readPaths.map(seatbeltAncestors).join(" ")})`,
    `(allow file-map-executable (subpath "/System") (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/usr/lib") (subpath "/Library/Apple") ${seatbeltSubpath(root)}${runtimeRoot ? ` ${seatbeltSubpath(runtimeRoot)}` : ""}${runtimeExecutableRoots.map((path) => ` ${seatbeltSubpath(path)}`).join("")})`,
    `(allow file-read* ${readPaths.map(seatbeltSubpath).join(" ")})`
  ];
  if (writePaths.length) clauses.push(`(allow file-write* ${writePaths.map(seatbeltSubpath).join(" ")})`);
  if (networkEnabled) clauses.push("(allow network-outbound)");
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
  filesystem: FilesystemRule[],
  networkEnabled: boolean,
  runtimeRoot: string | null,
  runtimeReadRoots: readonly string[]
): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-all", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"];
  if (networkEnabled) args.push("--share-net");
  const bindTargets = [root, ...filesystem.map((rule) => rule.path), ...(runtimeRoot ? [runtimeRoot] : []), ...runtimeReadRoots];
  for (const directory of new Set(bindTargets.flatMap(parentDirectories))) args.push("--dir", directory);
  for (const path of ["/usr", "/bin", "/lib", "/lib64"]) args.push("--ro-bind-try", path, path);
  args.push("--ro-bind", root, root);
  if (runtimeRoot && !["/usr", "/bin", "/lib", "/lib64"].includes(runtimeRoot)) args.push("--ro-bind", runtimeRoot, runtimeRoot);
  for (const path of runtimeReadRoots) args.push("--ro-bind", path, path);
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
  secrets: Readonly<Record<string, string>>,
  runtimePathEntries: readonly string[] = [],
  runtimeEnvironment: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const hostPath = [...new Set([...runtimePathEntries, "/usr/bin", "/bin"])].join(":");
  const env: Record<string, string> = { PATH: hostPath, LANG: "C.UTF-8", ...configured, ...runtimeEnvironment };
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

function asCommandSession(session: PluginSession): CommandPluginSession {
  if (!("children" in session)) throw new Error("Invalid command plugin session");
  return session as CommandPluginSession;
}
