import fs from "node:fs";
import dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecTool } from "../../../../src/core/agent-runtime/tools/shell.js";

const roots: string[] = [];
const unixOnly = process.platform === "win32" ? it.skip : it;

function tmpDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function fakeResolve(host: string, results: string[]) {
  return vi.spyOn(dns, "lookup").mockImplementation(async (hostname: string) => {
    if (hostname === host) return results.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) as any;
    throw new Error(`cannot resolve ${hostname}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("exec internal URL blocking", () => {
  it("blocks curl to metadata endpoints", async () => {
    const result = await new ExecTool().execute({
      command: 'curl -s -H "Metadata-Flavor: Google" http://169.254.169.254/computeMetadata/v1/',
    });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toMatch(/internal|private/);
  });

  it("blocks wget to localhost", async () => {
    const result = await new ExecTool().execute({ command: "wget http://localhost:8080/secret -O /tmp/out" });

    expect(result).toContain("Error");
  });

  it("allows normal commands", async () => {
    const result = await new ExecTool({ timeout: 5 }).execute({ command: "echo hello" });

    expect(result).toContain("hello");
    expect(result.split("\n")[0]).not.toContain("Error");
  });

  it("allows curl to a public literal URL at guard time", async () => {
    expect(await new ExecTool().guardCommand("curl https://93.184.216.34/api", "/tmp")).toBeNull();
  });

  it("blocks chained internal URLs", async () => {
    const result = await new ExecTool().execute({
      command: "echo start && curl http://169.254.169.254/latest/meta-data/ && echo done",
    });

    expect(result).toContain("Error");
  });

  it("blocks mixed-case internal URL schemes in the real execute path", async () => {
    const result = await new ExecTool().execute({ command: "curl HTTP://127.0.0.1/admin" });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toMatch(/internal|private/);
  });

  it("blocks internal URLs before shell separators in the real execute path", async () => {
    const result = await new ExecTool().execute({ command: "curl http://127.0.0.1; echo ok" });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toMatch(/internal|private/);
  });

  it("blocks hostnames that resolve to internal addresses in the real execute path", async () => {
    fakeResolve("metadata.local", ["169.254.169.254"]);

    const result = await new ExecTool().execute({ command: "curl http://metadata.local/latest" });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toMatch(/internal|private/);
  });

  it("does not treat shell pipes after public URLs as part of the URL", async () => {
    const result = await new ExecTool({ timeout: 5 }).execute({ command: "printf '%s\\n' https://93.184.216.34|cat" });

    expect(result).toContain("https://93.184.216.34");
    expect(result.split("\n")[0]).not.toContain("Error");
  });
});

describe("exec blocks writes to internal state files", () => {
  it.each([
    "cat foo >> history.jsonl",
    "echo '{}' > history.jsonl",
    "echo '{}' > memory/history.jsonl",
    "echo '{}' > ./workspace/memory/history.jsonl",
    "tee -a history.jsonl < foo",
    "tee history.jsonl",
    "cp /tmp/fake.jsonl history.jsonl",
    "mv backup.jsonl memory/history.jsonl",
    "dd if=/dev/zero of=memory/history.jsonl",
    "sed -i 's/old/new/' history.jsonl",
    "echo x > .dream_cursor",
    "cp /tmp/x memory/.dream_cursor",
  ])("blocks %s", async (command) => {
    const result = await new ExecTool().guardCommand(command, "/tmp");

    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("deny pattern filter");
  });

  it.each([
    "cat history.jsonl",
    "wc -l history.jsonl",
    "tail -n 5 history.jsonl",
    "grep foo history.jsonl",
    "cp history.jsonl /tmp/history.backup",
    "ls memory/",
    "echo history.jsonl",
  ])("allows read-only command %s", async (command) => {
    expect(await new ExecTool().guardCommand(command, "/tmp")).toBeNull();
  });
});

describe("exec restrictToWorkspace guard", () => {
  it("blocks working_dir outside the configured workspace", async () => {
    const workspace = tmpDir("memmy-exec-ws-");
    const result = await new ExecTool({ workspace, restrictToWorkspace: true }).execute({
      command: "rm calendar.ics",
      working_dir: "/etc",
    });

    expect(result).toContain("outside the configured workspace");
  });

  it("blocks absolute rm via hijacked working_dir", async () => {
    const workspace = tmpDir("memmy-exec-ws-");
    const victimDir = tmpDir("memmy-exec-outside-");
    const victim = path.join(victimDir, "file.ics");
    fs.writeFileSync(victim, "data");

    const result = await new ExecTool({ workspace, restrictToWorkspace: true }).execute({
      command: `rm ${victim}`,
      working_dir: victimDir,
    });

    expect(result).toContain("outside the configured workspace");
    expect(fs.existsSync(victim)).toBe(true);
  });

  it("allows working_dir inside the workspace", async () => {
    const workspace = tmpDir("memmy-exec-ws-");
    const subdir = path.join(workspace, "project");
    fs.mkdirSync(subdir);

    const result = await new ExecTool({ workspace, restrictToWorkspace: true, timeout: 5 }).execute({
      command: "echo ok",
      working_dir: subdir,
    });

    expect(result).toContain("ok");
    expect(result).not.toContain("outside the configured workspace");
  });

  it("allows working_dir equal to the workspace", async () => {
    const workspace = tmpDir("memmy-exec-ws-");

    const result = await new ExecTool({ workspace, restrictToWorkspace: true, timeout: 5 }).execute({
      command: "echo ok",
      working_dir: workspace,
    });

    expect(result).toContain("ok");
    expect(result).not.toContain("outside the configured workspace");
  });

  it("ignores workspace checks when not restricted", async () => {
    const workspace = tmpDir("memmy-exec-ws-");
    const other = tmpDir("memmy-exec-other-");

    const result = await new ExecTool({ workspace, restrictToWorkspace: false, timeout: 5 }).execute({
      command: "echo ok",
      working_dir: other,
    });

    expect(result).toContain("ok");
    expect(result).not.toContain("outside the configured workspace");
  });

  it.each([
    'rm test_print.txt 2>/dev/null; echo "done"',
    "find . -type f >/dev/null",
    "noisy_cmd 2>/dev/null",
    "noisy_cmd >/dev/null 2>&1",
    "head -c 16 /dev/urandom | xxd",
    "echo done >/dev/stderr",
    "echo line </dev/stdin",
    "cat /dev/fd/3",
  ])("allows benign device targets inside the workspace: %s", async (command) => {
    const workspace = tmpDir("memmy-exec-ws-");

    expect(await new ExecTool({ workspace, restrictToWorkspace: true }).guardCommand(command, workspace)).toBeNull();
  });

  unixOnly("allows rm with /dev/null redirect inside the workspace", async () => {
    const workspace = tmpDir("memmy-exec-ws-");
    const target = path.join(workspace, "test_print.txt");
    fs.writeFileSync(target, "scratch");

    const result = await new ExecTool({ workspace, restrictToWorkspace: true, timeout: 5 }).execute({
      command: `rm ${target} 2>/dev/null; echo "done"`,
      working_dir: workspace,
    });

    expect(result).toContain("done");
    expect(result).not.toContain("path outside working dir");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("still blocks real outside redirect targets", async () => {
    const workspace = tmpDir("memmy-exec-ws-");
    const blocked = await new ExecTool({ workspace, restrictToWorkspace: true }).guardCommand("echo pwn > /etc/issue", workspace);

    expect(blocked).not.toBeNull();
    expect(blocked).toContain("path outside working dir");
  });
});

describe("exec disk format blocking", () => {
  it.each(["format C: /q", "format D: /fs:ntfs", "&& format", "| format", "&format", ";format", "|format"])(
    "blocks %s",
    async (command) => {
      const result = await new ExecTool().guardCommand(command, "/tmp");

      expect(result).not.toBeNull();
      expect(result!.toLowerCase()).toContain("deny pattern filter");
    },
  );

  it.each([
    'curl -s "wttr.in/xxx?lang=zh&format=%l:+%c+%t+%h+%w&1"',
    'curl -s "wttr.in/xxx?format=%l:+%c+%t+%h+%w&1"',
    "echo format",
    "echo reformat",
  ])("allows harmless use of format: %s", async (command) => {
    expect(await new ExecTool().guardCommand(command, "/tmp")).toBeNull();
  });
});
