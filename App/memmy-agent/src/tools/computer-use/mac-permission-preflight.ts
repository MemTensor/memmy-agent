import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestContext } from "../../core/agent-runtime/tools/context.js";
import type { MacPermission } from "./mac-permission-settings.js";

const execFileAsync = promisify(execFile);
export type PermissionPreflight = { state: "granted" } | { state: "missing"; permission: MacPermission; missingPermissions?: MacPermission[] } | { state: "unknown" };

export function parsePermissionDoctor(stdout: string): PermissionPreflight {
  const match = stdout.match(/^Permissions: accessibility=(granted|missing), screenRecording=(granted|missing)\s*$/m);
  if (!match) return { state: "unknown" };
  const missingPermissions: MacPermission[] = [];
  if (match[1] === "missing") missingPermissions.push("accessibility");
  if (match[2] === "missing") missingPermissions.push("screenRecording");
  if (missingPermissions.length) return { state: "missing", permission: missingPermissions[0], missingPermissions };
  return { state: "granted" };
}

/** Uses the same launcher, arguments, environment and native app identity as MCP.
 * doctor never receives the target app. The pinned native runtime presents its
 * own onboarding when permissions are missing, without opening the target.
 */
export function nativePermissionDoctor(options: {
  command: string; args: string[]; env: Record<string, string> | null; cwd: string | null;
}): () => Promise<PermissionPreflight> {
  return async () => {
    if (options.args.at(-1) !== "mcp") return { state: "unknown" };
    try {
      const { stdout } = await execFileAsync(options.command, [...options.args.slice(0, -1), "doctor"], {
        env: { ...getDefaultEnvironment(), ...options.env },
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
      return parsePermissionDoctor(stdout);
    } catch {
      // Timeout, unsupported custom launchers and malformed output cannot prove
      // access. Never send the target operation in these cases.
      return { state: "unknown" };
    }
  };
}

/** Shared by all tools in one MCP connection. A denied turn stays denied even
 * if the user grants access while the model is still generating tool calls.
 */
export class MacPermissionPreflight {
  private readonly turns = new Map<string | object, Promise<PermissionPreflight>>();
  private inFlight: Promise<PermissionPreflight> | null = null;
  private readonly denied = new Map<string, Promise<PermissionPreflight>>();
  constructor(private readonly read: () => Promise<PermissionPreflight>) {}

  private key(context: RequestContext | null): string | null {
    if (!context || context.metadata.computerUseInteractive === false) return null;
    const messageId = context.messageId ?? context.metadata.message_id ?? context.metadata.messageId ?? context.metadata.turnId ?? context.metadata.turn_id;
    if (!messageId || ['system', 'cron'].includes(context.channel ?? '')) return null;
    return JSON.stringify([context.sessionKey, context.channel, context.chatId, messageId]);
  }
  blocked(context: RequestContext | null): Promise<PermissionPreflight> | undefined {
    const key = this.key(context);
    return key ? this.denied.get(key) : Promise.resolve({ state: 'unknown' });
  }
  check(context: RequestContext | null, generation = 0): Promise<PermissionPreflight> {
    const key = this.key(context);
    if (!key) return Promise.resolve({ state: 'unknown' });
    const denied = this.denied.get(key);
    if (denied) return denied;
    const cacheKey = `${generation}:${key}`;
    const previous = this.turns.get(cacheKey);
    if (previous) return previous;
    if (!this.inFlight) {
      this.inFlight = Promise.resolve().then(() => this.read()).catch(() => ({ state: 'unknown' } as const))
        .finally(() => { this.inFlight = null; });
    }
    const pending = this.inFlight.then(status => {
      if (status.state !== 'granted') this.rememberDenied(key, status);
      return status;
    });
    this.turns.set(cacheKey, pending);
    if (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value!);
    return pending;
  }
  private rememberDenied(key: string, status: PermissionPreflight): void {
    this.denied.set(key, Promise.resolve(status));
    if (this.denied.size > 256) this.denied.delete(this.denied.keys().next().value!);
  }
  remember(context: RequestContext | null, status: PermissionPreflight, generation: number): void {
    const key = this.key(context);
    if (!key) return;
    if (status.state !== 'granted') this.rememberDenied(key, status);
    else {
      this.turns.set(`${generation}:${key}`, Promise.resolve(status));
      if (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value!);
    }
  }
  deny(context: RequestContext | null, permission: MacPermission): void {
    const key = this.key(context);
    if (key) this.rememberDenied(key, { state: 'missing', permission });
  }
  block(context: RequestContext | null): void {
    const key = this.key(context);
    if (key) this.rememberDenied(key, { state: 'unknown' });
  }
}
