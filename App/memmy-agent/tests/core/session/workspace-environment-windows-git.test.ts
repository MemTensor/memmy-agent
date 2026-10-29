import { beforeEach, describe, expect, it, vi } from "vitest";

const execFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal: () => Promise<typeof import("node:child_process")>) => ({
  ...await importOriginal(),
  execFile,
}));

import {
  readWorkspaceEnvironment,
  readWorkspaceFileDiff,
  type WorkspaceEnvironmentContext,
} from "../../../src/core/session/workspace-environment.js";

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STATUS = [
  "# branch.oid abcdef",
  "# branch.head main",
  `1 .M N... 100644 100644 100644 ${HASH} ${HASH} src\\todo.py\r`,
  "? src\\New.py\r",
].join("\0") + "\0";

function gitSubcommand(args: string[]): string {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index] ?? "";
}

function respond(callback: ((...args: unknown[]) => void) | undefined, error: Error | null, stdout = "", stderr = ""): void {
  callback?.(error, stdout, stderr);
}

function installGit(options: { blockUntilTrusted?: boolean } = {}): void {
  execFile.mockImplementation((_command: string, args: string[] = [], _options?: { cwd?: string }, callback?: (...args: unknown[]) => void) => {
    if (options.blockUntilTrusted && !args.includes(`safe.directory=${_options?.cwd}`)) {
      const error = Object.assign(new Error("dubious ownership"), { code: 128 });
      respond(callback, error, "", "fatal: detected dubious ownership in repository at 'C:/share/repo'");
      return;
    }
    const command = gitSubcommand(args);
    if (command === "rev-parse") return respond(callback, null, "C:/Users/vm/repo\r\n");
    if (command === "status") return respond(callback, null, STATUS);
    if (command === "for-each-ref") return respond(callback, null, "main\n");
    if (command === "diff" && args.includes("--numstat")) return respond(callback, null, "1\t1\tsrc\\todo.py\r\0");
    if (command === "diff") return respond(callback, null, "@@ -1 +1 @@\n-old\n+new\n");
    respond(callback, new Error(`unexpected ${command}`), "", `unexpected ${command}`);
  });
}

const context: WorkspaceEnvironmentContext = {
  scope: { kind: "session", key: "windows-vm" },
  cwd: "C:/Users/vm/repo",
  metadata: {},
};

describe("workspace git on Windows", () => {
  beforeEach(() => {
    execFile.mockReset();
    installGit();
  });

  it("reads a diff when porcelain paths use backslashes and carriage returns", async () => {
    const environment = await readWorkspaceEnvironment(context);

    expect(environment.files.map((file) => file.path)).toEqual(["src/todo.py", "src/New.py"]);
    expect(await readWorkspaceFileDiff(environment, "src/todo.py")).toMatchObject({
      path: "src/todo.py",
      unavailable_reason: null,
    });
    expect((await readWorkspaceFileDiff(environment, "src/todo.py"))?.diff).toContain("+new");
    expect(await readWorkspaceFileDiff(environment, "src/New.py")).toMatchObject({
      unavailable_reason: "untracked_diff_unavailable",
    });
    expect(await readWorkspaceFileDiff(environment, "../outside.txt")).toBeNull();
    const diffArgs = execFile.mock.calls.map((call) => call[1] as string[]).find((args) => gitSubcommand(args) === "diff" && !args.includes("--numstat"));
    expect(diffArgs).toContain("src/todo.py");
  });

  it("retries when a VM shared folder is blocked for dubious ownership", async () => {
    installGit({ blockUntilTrusted: true });

    const environment = await readWorkspaceEnvironment(context);

    expect(environment.snapshot.status).toBe("ready");
    expect(environment.files.map((file) => file.path)).toEqual(["src/todo.py", "src/New.py"]);
    const calls = execFile.mock.calls.map((call) => ({ args: call[1] as string[], cwd: (call[2] as { cwd: string }).cwd }));
    const retries = calls.filter(call => call.args[0] === "-c");
    expect(retries.length).toBeGreaterThan(0);
    expect(retries.every(call => call.args[1] === `safe.directory=${call.cwd}`)).toBe(true);
    expect(calls.some(call => call.args.includes("safe.directory=*"))).toBe(false);
    expect(calls.some(call => gitSubcommand(call.args) === "config")).toBe(false);
  });
});
