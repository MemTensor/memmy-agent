import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adaptersDirectory } from "../assist/adapters.js";
import { ASSIST_LOGIN_ENV, assistLoginCommand, assistSignedIn, signIn } from "../assist/login.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-login-"));
  roots.push(root);
  return root;
}

/** 一个可以直接被 node 走的脚本。 */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

describe("各 Agent 的登录命令", () => {
  it("uses the Claude Code adapter's own CLI so the login is shared with the command line", () => {
    const command = assistLoginCommand("claude_code", { adapterExecutable: "/tmp/adapters/claude-agent-acp" });
    // 适配器把 --cli 之后的参数原样交给自带的 claude：登录结果写进 ~/.claude，与命令行共用。
    expect(command).toEqual({
      command: "/tmp/adapters/claude-agent-acp",
      args: ["--cli", "auth", "login", "--claudeai"]
    });
  });

  it("uses the codex that came with the adapter instead of whatever is on PATH", () => {
    const home = workdir();
    const binDir = join(adaptersDirectory(home), "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");
    // 适配器不装成也照样能找到它那份 codex：判断只看 .bin 里的文件在不在。
    expect(assistLoginCommand("codex", { home, env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv }))
      .toEqual({ command: join(binDir, "codex"), args: ["login"] });
  });

  it("uses QwenWork's engine from the app bundle", () => {
    const root = workdir();
    const bundle = join(root, "QwenWorkCN.app");
    const bin = join(bundle, "Contents", "Resources", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "qoderclicn"), "#!/bin/sh\n");
    chmodSync(join(bin, "qoderclicn"), 0o755);

    expect(assistLoginCommand("qwenwork", {
      env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
      qwenWorkAppDirs: [bundle]
    })).toEqual({ command: join(bin, "qoderclicn"), args: ["login"] });
  });

  it("does not invent a login command for agents whose login cannot run without a terminal", () => {
    // Cursor、OpenCode、OpenClaw、Hermes、DeepSeek Harness 没有可代为执行的登录命令：只提示去登录。
    for (const sourceId of ["cursor", "opencode", "openclaw", "hermes", "deepseek_harness"]) {
      expect(assistLoginCommand(sourceId, { env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv })).toBeNull();
    }
  });

  it("lets the login command be overridden for support cases", () => {
    const dir = workdir();
    const fake = script(dir, "login.sh", "#!/bin/sh\nexit 0\n");
    const env = { PATH: "/usr/bin:/bin", [ASSIST_LOGIN_ENV("cursor")]: `${fake} --now` } as NodeJS.ProcessEnv;
    expect(assistLoginCommand("cursor", { env })).toEqual({ command: fake, args: ["--now"] });
  });
});

describe("assistSignedIn", () => {
  it("reads Claude Code's login state as JSON", async () => {
    const dir = workdir();
    const adapter = script(dir, "claude-agent-acp.js", `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ loggedIn: true }));`);
    expect(await assistSignedIn("claude_code", { adapterExecutable: adapter, env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv }))
      .toBe(true);

    // 实测：未登录时它照样打印 JSON，但以 1 退出。按输出判断，不看退出码。
    const out = script(
      dir,
      "claude-out.js",
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ loggedIn: false }));process.exit(1);`
    );
    expect(await assistSignedIn("claude_code", { adapterExecutable: out, env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv }))
      .toBe(false);
  });

  it("reads QwenWork's account line", async () => {
    const root = workdir();
    const bundle = join(root, "QwenWorkCN.app");
    const bin = join(bundle, "Contents", "Resources", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "qoderclicn"), "#!/bin/sh\necho 'Account: Not logged in'\n");
    chmodSync(join(bin, "qoderclicn"), 0o755);

    expect(await assistSignedIn("qwenwork", {
      env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
      qwenWorkAppDirs: [bundle]
    })).toBe(false);
  });

  it("says it does not know for Codex, which may use an API key instead of a login", async () => {
    // 只看 auth.json 在不在会误判：config.toml 里可能有自定义 provider。
    expect(await assistSignedIn("codex", { env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv })).toBeNull();
  });
});

describe("signIn", () => {
  /** 一次登录的结果与执行方看到的进展。 */
  async function attempt(
    body: string,
    options: { timeoutMs?: number; signal?: AbortSignal; sourceId?: string } = {}
  ) {
    const dir = workdir();
    const marker = join(dir, "login-ran");
    const command = script(dir, "login.js", `#!${process.execPath}\n${body.replace("__MARKER__", marker)}`);
    const env = {
      PATH: "/usr/bin:/bin",
      [ASSIST_LOGIN_ENV(options.sourceId ?? "codex")]: command
    } as NodeJS.ProcessEnv;
    const steps: string[] = [];
    const controller = new AbortController();
    const outcome = await signIn({
      sourceId: options.sourceId ?? "codex",
      name: "Codex",
      env,
      onStep: (step) => steps.push(step.text),
      signal: options.signal ?? controller.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    });
    return { outcome, steps, marker, signal: controller };
  }

  it("opens the login page and waits for the person to finish", async () => {
    const { outcome, steps, marker } = await attempt(
      'require("node:fs").writeFileSync("__MARKER__", "1");'
    );
    expect(outcome).toBe("ok");
    expect(existsSync(marker)).toBe(true);
    // 执行方要在她自己的 Memmy 里看到这一步，知道去浏览器完成。
    expect(steps.join("\n")).toContain("Codex 没有登录，已在浏览器打开登录页，请在浏览器中完成登录");
  });

  it("says the login did not finish when the command exits with an error", async () => {
    const { outcome } = await attempt("process.exit(3);");
    expect(outcome).toBe("failed");
  });

  it("gives up on its own when the login page is not finished in time", async () => {
    const started = Date.now();
    const { outcome } = await attempt("setTimeout(() => process.exit(0), 5000);", { timeoutMs: 300 });
    expect(outcome).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops when the person stops the run", async () => {
    const controller = new AbortController();
    const running = attempt("setTimeout(() => process.exit(0), 5000);", { signal: controller.signal });
    controller.abort();
    expect((await running).outcome).toBe("cancelled");
  });

  it("only prompts to log in when there is no login command to run", async () => {
    const dir = workdir();
    const steps: string[] = [];
    const outcome = await signIn({
      sourceId: "cursor",
      name: "Cursor",
      env: { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
      onStep: (step) => steps.push(step.text),
      signal: new AbortController().signal
    });
    expect(outcome).toBe("unsupported");
    // 没有代为登录的路子时不要先跟人说「已经在浏览器打开登录页」。
    expect(steps).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});
