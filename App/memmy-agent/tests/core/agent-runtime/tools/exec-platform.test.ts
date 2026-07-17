import { EventEmitter } from "node:events";
import path from "node:path";
import iconv from "iconv-lite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecTool, setIsWindowsForTest } from "../../../../src/core/agent-runtime/tools/shell.js";

const WINDOWS_COMMAND_NOT_FOUND = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。\r\n";

const WINDOWS_ENV_KEYS = new Set([
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
]);

function restorePlatform() {
  setIsWindowsForTest(process.platform === "win32");
}

async function prepared(value: ReturnType<ExecTool["prepareCommand"]>) {
  const resolved = await value;
  expect(typeof resolved).not.toBe("string");
  return resolved as Exclude<typeof resolved, string>;
}

function fakeChild(stdout: string | Buffer = "hello world\n", stderr: string | Buffer = "", code = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  setTimeout(() => {
    if (stdout.length) child.stdout.emit("data", Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    if (stderr.length) child.stderr.emit("data", Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr));
    child.emit("close", code);
  }, 0);
  return child;
}

afterEach(() => {
  restorePlatform();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.MEMMY_AGENT_TOKEN;
});

describe("ExecTool buildEnv on Unix", () => {
  it("contains only the expected base keys", () => {
    setIsWindowsForTest(false);

    const env = new ExecTool().buildEnv();

    expect(new Set(Object.keys(env))).toEqual(new Set(["HOME", "LANG", "TERM"]));
  });

  it("uses HOME from the parent environment", () => {
    const oldHome = process.env.HOME;
    process.env.HOME = "/Users/dev";
    setIsWindowsForTest(false);

    expect(new ExecTool().buildEnv().HOME).toBe("/Users/dev");

    process.env.HOME = oldHome;
  });

  it("excludes secrets", () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    process.env.MEMMY_AGENT_TOKEN = "tok-secret";
    setIsWindowsForTest(false);

    const env = new ExecTool().buildEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.MEMMY_AGENT_TOKEN).toBeUndefined();
    expect(Object.values(env).join("\n").toLowerCase()).not.toContain("secret");
  });
});

describe("ExecTool buildEnv on Windows", () => {
  it("contains the expected Windows keys", () => {
    setIsWindowsForTest(true);

    const env = new ExecTool().buildEnv();

    expect(new Set(Object.keys(env))).toEqual(
      new Set([
        "SYSTEMROOT",
        "COMSPEC",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "TEMP",
        "TMP",
        "PATHEXT",
        "PATH",
        ...WINDOWS_ENV_KEYS,
      ]),
    );
  });

  it("excludes secrets", () => {
    process.env.OPENAI_API_KEY = "sk-secret";
    process.env.MEMMY_AGENT_TOKEN = "tok-secret";
    setIsWindowsForTest(true);

    const env = new ExecTool().buildEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.MEMMY_AGENT_TOKEN).toBeUndefined();
    expect(Object.values(env).join("\n").toLowerCase()).not.toContain("secret");
  });

  it("uses a sensible PATH default", () => {
    const oldPath = process.env.PATH;
    delete process.env.PATH;
    setIsWindowsForTest(true);

    expect(new ExecTool().buildEnv().PATH?.toLowerCase()).toContain("system32");

    process.env.PATH = oldPath;
  });

  it("forwards SYSTEMROOT", () => {
    const old = process.env.SYSTEMROOT;
    process.env.SYSTEMROOT = "D:\\Windows";
    setIsWindowsForTest(true);

    expect(new ExecTool().buildEnv().SYSTEMROOT).toBe("D:\\Windows");

    if (old == null) delete process.env.SYSTEMROOT;
    else process.env.SYSTEMROOT = old;
  });
});

describe("ExecTool platform-specific command preparation", () => {
  it("uses a fixed env variable export for Unix pathAppend", async () => {
    setIsWindowsForTest(false);

    const result = await prepared(new ExecTool({ pathAppend: "/opt/bin; echo INJECTED" }).prepareCommand("ls"));

    expect(result.command).toBe('export PATH="$PATH:$MEMMY_AGENT_PATH_APPEND"; ls');
    expect(result.env.MEMMY_AGENT_PATH_APPEND).toBe("/opt/bin; echo INJECTED");
    expect(result.command).not.toContain("INJECTED");
  });

  it("modifies PATH directly for Windows pathAppend", async () => {
    setIsWindowsForTest(true);

    const result = await prepared(new ExecTool({ pathAppend: "C:\\tools\\bin" }).prepareCommand("dir"));

    expect(result.env.PATH).toMatch(/;C:\\tools\\bin$/);
  });

  it("skips bwrap on Windows", async () => {
    setIsWindowsForTest(true);

    const result = await prepared(new ExecTool({ sandbox: "bwrap" }).prepareCommand("dir"));

    expect(result.command).not.toContain("bwrap");
  });

  it("applies bwrap on Unix", async () => {
    setIsWindowsForTest(false);

    const result = await prepared(new ExecTool({ sandbox: "bwrap", workspace: process.cwd() }).prepareCommand("ls"));

    expect(result.command).toContain("bwrap");
  });
});

describe("ExecTool execute with mocked spawn", () => {
  it("formats output from the full Windows path", async () => {
    setIsWindowsForTest(true);
    const spawn = vi.spyOn(ExecTool, "spawnProcess").mockImplementation(async () => fakeChild("hello world\r\n") as any);

    const result = await new ExecTool().execute({ command: "echo hello world" });

    expect(result).toContain("hello world");
    expect(result).toContain("Exit code: 0");
    expect(spawn.mock.calls[0][0]).toBe("echo hello world");
  });

  it("decodes CP936 output from the full Windows path", async () => {
    setIsWindowsForTest(true);
    vi.spyOn(ExecTool, "spawnProcess").mockImplementation(async () => (
      fakeChild(iconv.encode(WINDOWS_COMMAND_NOT_FOUND, "cp936"), "", 9009) as any
    ));

    const result = await new ExecTool({ commandOutputDecoderOptions: { oemCodePage: 936 } }).execute({ command: "node" });

    expect(result).toContain(WINDOWS_COMMAND_NOT_FOUND);
    expect(result).toContain("Exit code: 9009");
    expect(result).not.toContain("�");
  });

  it("decodes UTF-8 stdout and CP936 stderr independently on Windows", async () => {
    setIsWindowsForTest(true);
    vi.spyOn(ExecTool, "spawnProcess").mockImplementation(async () => (
      fakeChild(Buffer.from("UTF-8 中文\r\n"), iconv.encode("系统错误\r\n", "cp936"), 1) as any
    ));

    const result = await new ExecTool({ commandOutputDecoderOptions: { oemCodePage: 936 } }).execute({ command: "mixed-output" });

    expect(result).toContain("UTF-8 中文\r\n");
    expect(result).toContain("STDERR:\n系统错误\r\n");
    expect(result).toContain("Exit code: 1");
  });

  it("passes cwd and env through to the Windows spawn path", async () => {
    setIsWindowsForTest(true);
    const cwd = process.cwd();
    const spawn = vi.spyOn(ExecTool, "spawnProcess").mockImplementation(async () => fakeChild("hello world\r\n") as any);

    await new ExecTool({ workspace: cwd }).execute({ command: "echo hello world" });

    expect(spawn.mock.calls[0][1]).toBe(cwd);
    expect(spawn.mock.calls[0][2].PATH).toBeDefined();
  });

  it("formats output from the full Unix path", async () => {
    setIsWindowsForTest(false);
    vi.spyOn(ExecTool, "spawnProcess").mockImplementation(async () => fakeChild("hello world\n") as any);

    const result = await new ExecTool().execute({ command: "echo hello world" });

    expect(result).toContain("hello world");
    expect(result).toContain("Exit code: 0");
  });
});

describe("ExecTool absolute path extraction", () => {
  it("extracts Windows drive paths", () => {
    expect(ExecTool.extractAbsolutePaths("dir C:\\Users\\Public")).toContain("C:\\Users\\Public");
  });

  it("extracts Windows drive roots", () => {
    expect(ExecTool.extractAbsolutePaths("dir C:\\")).toContain("C:\\");
  });

  it("extracts simple UNC paths", () => {
    expect(ExecTool.extractAbsolutePaths("dir \\\\server\\share")).toContain("\\\\server\\share");
  });

  it("extracts UNC paths with subdirectories", () => {
    const paths = ExecTool.extractAbsolutePaths("copy \\\\server\\share\\folder\\file.txt D:\\backup");

    expect(paths).toContain("\\\\server\\share\\folder\\file.txt");
    expect(paths).toContain("D:\\backup");
  });

  it("extracts quoted UNC paths", () => {
    expect(ExecTool.extractAbsolutePaths('type "\\\\server\\share\\docs\\readme.txt"')).toContain(
      "\\\\server\\share\\docs\\readme.txt",
    );
  });

  it("extracts mixed Windows, UNC, and POSIX paths", () => {
    const paths = ExecTool.extractAbsolutePaths("copy \\\\server\\data\\file.txt C:\\local\\temp && ls /tmp");

    expect(paths).toContain("\\\\server\\data\\file.txt");
    expect(paths).toContain("C:\\local\\temp");
    expect(paths).toContain("/tmp");
  });

  it("extracts home paths", () => {
    expect(ExecTool.extractAbsolutePaths("cat ~/config.txt")).toContain("~/config.txt");
  });

  it("returns an empty list when no paths are present", () => {
    expect(ExecTool.extractAbsolutePaths("echo hello")).toEqual([]);
  });

  it("does not treat URL paths as filesystem paths", () => {
    expect(ExecTool.extractAbsolutePaths("curl https://example.com/api/v1")).toEqual([]);
  });

  it("keeps path parsing stable across platforms", () => {
    const paths = ExecTool.extractAbsolutePaths(`cat ${path.posix.join("/tmp", "file.txt")}`);

    expect(paths).toContain("/tmp/file.txt");
  });
});
