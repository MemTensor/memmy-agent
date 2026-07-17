import path from "node:path";
import { getMediaDir } from "../../../config/paths.js";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export class SandboxConfig {
  mode: SandboxMode = "workspace-write";
  constructor(init: Partial<SandboxConfig> = {}) {
    Object.assign(this, init);
  }
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function shJoin(args: string[]): string {
  return args.map(quoteArg).join(" ");
}

function bwrap(command: string, workspace: string, cwd: string): string {
  const ws = path.resolve(workspace);
  const requestedCwd = path.resolve(cwd);
  const sandboxCwd = requestedCwd === ws || requestedCwd.startsWith(`${ws}${path.sep}`) ? requestedCwd : ws;
  const media = path.resolve(getMediaDir());
  const required = ["/usr"];
  const optional = ["/bin", "/lib", "/lib64", "/etc/alternatives", "/etc/ssl/certs", "/etc/resolv.conf", "/etc/ld.so.cache"];
  const args = ["bwrap", "--new-session", "--die-with-parent"];
  for (const entry of required) args.push("--ro-bind", entry, entry);
  for (const entry of optional) args.push("--ro-bind-try", entry, entry);
  args.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    path.dirname(ws),
    "--dir",
    ws,
    "--bind",
    ws,
    ws,
    "--ro-bind-try",
    media,
    media,
    "--chdir",
    sandboxCwd,
    "--",
    "sh",
    "-c",
    command,
  );
  return shJoin(args);
}

const BACKENDS: Record<string, (command: string, workspace: string, cwd: string) => string> = {
  bwrap,
};

export function wrapCommand(sandbox: string, command: string, workspace: string, cwd: string): string {
  const backend = BACKENDS[sandbox];
  if (!backend) throw new Error(`Unknown sandbox backend ${JSON.stringify(sandbox)}. Available: ${Object.keys(BACKENDS).join(", ")}`);
  return backend(command, workspace, cwd);
}
