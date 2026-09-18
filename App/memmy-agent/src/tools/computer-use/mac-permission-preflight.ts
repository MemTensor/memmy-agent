import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestContext } from "../../core/agent-runtime/tools/context.js";
import type { MacPermission } from "./mac-permission-settings.js";

const execFileAsync = promisify(execFile);
export type PermissionPreflight = { state: "granted" } | { state: "missing"; permission: MacPermission } | { state: "unknown" };

export function parsePermissionDoctor(stdout: string): PermissionPreflight {
  const match = stdout.match(/^Permissions: accessibility=(granted|missing), screenRecording=(granted|missing)\s*$/m);
  if (!match) return { state: "unknown" };
  if (match[1] === "missing") return { state: "missing", permission: "accessibility" };
  if (match[2] === "missing") return { state: "missing", permission: "screenRecording" };
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
        timeout: 5000,
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
  private readonly noContext = {};
  constructor(private readonly read: () => Promise<PermissionPreflight>) {}

  private key(context: RequestContext | null): string | object {
    if (!context) return this.noContext;
    const turnId = context.metadata.turnId ?? context.metadata.turn_id ?? context.messageId;
    return turnId ? JSON.stringify([context.sessionKey, context.channel, context.chatId, turnId]) : context;
  }

  check(context: RequestContext | null): Promise<PermissionPreflight> {
    const key = this.key(context);
    const previous = this.turns.get(key);
    if (previous) return previous;
    const pending = Promise.resolve().then(() => this.read()).catch(() => ({ state: "unknown" } as const));
    this.turns.set(key, pending);
    // Bound retained completed turn identities for long-running MCP sessions.
    if (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value!);
    return pending;
  }

  deny(context: RequestContext | null, permission: MacPermission): void {
    this.turns.set(this.key(context), Promise.resolve({ state: "missing", permission }));
  }
}
