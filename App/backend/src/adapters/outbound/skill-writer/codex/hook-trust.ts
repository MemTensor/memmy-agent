/** Codex hook trust persistence through the Codex app-server protocol. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { basename, join, normalize } from "node:path";

const APP_SERVER_REQUEST_TIMEOUT_MS = 10_000;
const APP_SERVER_CLOSE_TIMEOUT_MS = 1_000;
const MAX_STDERR_LENGTH = 8_192;
const MEMMY_HOOK_EVENTS = new Set(["userPromptSubmit", "stop"]);

export interface TrustMemmyCodexHooksOptions {
  codexHomeDirectory: string;
  hooksFilePath: string;
  hookCommand: string;
  codexExecutable?: string;
  appServerArguments?: string[];
}

export type TrustMemmyCodexHooks = (options: TrustMemmyCodexHooksOptions) => Promise<void>;

interface CodexHookMetadata {
  key: string;
  eventName: string;
  handlerType: string;
  command: string | null;
  source: string;
  sourcePath: string;
  currentHash: string;
  trustStatus: string;
  enabled: boolean;
  isManaged: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface CodexAppServerClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** Trusts only the two user-level Memmy hooks that Codex discovered from hooks.json. */
export async function trustMemmyCodexHooks(options: TrustMemmyCodexHooksOptions): Promise<void> {
  const client = createCodexAppServerClient(options);
  try {
    await client.request("initialize", {
      clientInfo: {
        name: "memmy",
        title: "Memmy",
        version: "1"
      }
    });
    client.notify("initialized", {});

    const hooks = selectMemmyHooks(
      await listHooks(client, options.codexHomeDirectory),
      options.hooksFilePath,
      options.hookCommand
    );
    const trustState = Object.fromEntries(hooks.map((hook) => [
      hook.key,
      { trusted_hash: hook.currentHash, enabled: true }
    ]));

    await client.request("config/batchWrite", {
      edits: [{
        keyPath: "hooks.state",
        value: trustState,
        mergeStrategy: "upsert"
      }],
      reloadUserConfig: true
    });

    const verifiedHooks = await listHooks(client, options.codexHomeDirectory);
    for (const hook of hooks) {
      const verified = verifiedHooks.find((candidate) => candidate.key === hook.key);
      if (!verified || verified.currentHash !== hook.currentHash || verified.trustStatus !== "trusted" || !verified.enabled) {
        throw new Error(`Codex did not persist trust for the Memmy ${hook.eventName} hook`);
      }
    }
  } finally {
    await client.close();
  }
}

async function listHooks(client: CodexAppServerClient, cwd: string): Promise<CodexHookMetadata[]> {
  const response = await client.request("hooks/list", { cwds: [cwd] });
  if (!isRecord(response) || !Array.isArray(response.data)) {
    throw new Error("Codex returned an invalid hooks/list response");
  }

  const hooks: CodexHookMetadata[] = [];
  for (const entry of response.data) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      continue;
    }
    for (const hook of entry.hooks) {
      const parsed = parseHookMetadata(hook);
      if (parsed) {
        hooks.push(parsed);
      }
    }
  }
  return hooks;
}

function selectMemmyHooks(
  hooks: CodexHookMetadata[],
  hooksFilePath: string,
  hookCommand: string
): CodexHookMetadata[] {
  const sourcePath = normalize(hooksFilePath);
  const selected = hooks.filter((hook) =>
    hook.source === "user" &&
    !hook.isManaged &&
    hook.handlerType === "command" &&
    normalize(hook.sourcePath) === sourcePath &&
    hook.command === hookCommand &&
    MEMMY_HOOK_EVENTS.has(hook.eventName)
  );
  const selectedEvents = new Set(selected.map((hook) => hook.eventName));
  if (selected.length !== MEMMY_HOOK_EVENTS.size || selectedEvents.size !== MEMMY_HOOK_EVENTS.size) {
    throw new Error("Codex did not discover both installed Memmy hooks");
  }
  return selected;
}

function parseHookMetadata(value: unknown): CodexHookMetadata | null {
  if (!isRecord(value) ||
      typeof value.key !== "string" ||
      typeof value.eventName !== "string" ||
      typeof value.handlerType !== "string" ||
      !(typeof value.command === "string" || value.command === null) ||
      typeof value.source !== "string" ||
      typeof value.sourcePath !== "string" ||
      typeof value.currentHash !== "string" ||
      typeof value.trustStatus !== "string" ||
      typeof value.enabled !== "boolean" ||
      typeof value.isManaged !== "boolean") {
    return null;
  }
  return value as unknown as CodexHookMetadata;
}

function createCodexAppServerClient(options: TrustMemmyCodexHooksOptions): CodexAppServerClient {
  const executable = options.codexExecutable ?? resolveCodexExecutable(options.codexHomeDirectory);
  const args = options.appServerArguments ?? ["app-server", "--stdio"];
  const child = spawn(executable, args, {
    cwd: options.codexHomeDirectory,
    env: { ...process.env, CODEX_HOME: options.codexHomeDirectory },
    stdio: ["pipe", "pipe", "pipe"]
  });
  return createJsonLineClient(child);
}

function createJsonLineClient(child: ChildProcessWithoutNullStreams): CodexAppServerClient {
  let nextRequestId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closing = false;
  let terminalError: Error | null = null;
  const pending = new Map<number, PendingRequest>();

  const failPending = (error: Error) => {
    terminalError = error;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        handleResponseLine(line, pending);
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer = `${stderrBuffer}${chunk}`.slice(-MAX_STDERR_LENGTH);
  });
  child.stdin.on("error", (error) => failPending(new Error(`Codex app-server input failed: ${error.message}`)));
  child.on("error", (error) => failPending(new Error(`Unable to start Codex app-server: ${error.message}`)));
  child.on("exit", (code, signal) => {
    if (!closing) {
      const detail = stderrBuffer.trim();
      failPending(new Error(
        `Codex app-server exited before hook trust completed (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`
      ));
    }
  });

  return {
    request(method, params) {
      if (terminalError) {
        return Promise.reject(terminalError);
      }
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex app-server request timed out: ${method}`));
        }, APP_SERVER_REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timeout });
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
          if (!error) {
            return;
          }
          const request = pending.get(id);
          if (request) {
            clearTimeout(request.timeout);
            pending.delete(id);
            request.reject(error);
          }
        });
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    },
    async close() {
      closing = true;
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill();
          resolve();
        }, APP_SERVER_CLOSE_TIMEOUT_MS);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  };
}

function handleResponseLine(line: string, pending: Map<number, PendingRequest>): void {
  let message: unknown;
  try {
    message = JSON.parse(line) as unknown;
  } catch {
    return;
  }
  if (!isRecord(message) || typeof message.id !== "number") {
    return;
  }
  const request = pending.get(message.id);
  if (!request) {
    return;
  }
  clearTimeout(request.timeout);
  pending.delete(message.id);
  if (isRecord(message.error)) {
    request.reject(new Error(
      typeof message.error.message === "string" ? message.error.message : "Codex app-server request failed"
    ));
    return;
  }
  request.resolve(message.result);
}

function resolveCodexExecutable(codexHomeDirectory: string): string {
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  const bundledExecutable = join(codexHomeDirectory, "plugins", ".plugin-appserver", executableName);
  return isExecutableFile(bundledExecutable) ? bundledExecutable : executableName;
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile() && basename(filePath).toLowerCase().startsWith("codex");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
