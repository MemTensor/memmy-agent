import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOGIN_SHELL_TIMEOUT_MS,
  assistEnv,
  assistSearchPath,
  readLoginShellPath
} from "../assist/shell-env.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workdir(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-shell-"));
  roots.push(root);
  return root;
}

describe("读登录 shell 的 PATH", () => {
  it("takes only what is between the markers, not the noise an rc file prints", () => {
    // rc 文件经常打印版本提示、首次配置向导，整段输出不能当 PATH 用。
    const output = [
      "Welcome to zsh!",
      "nvm: 现在使用 node v22.22.2",
      "__MEMMY_ASSIST_PATH__/opt/homebrew/bin:/Users/someone/.nvm/versions/node/v22.22.2/bin__MEMMY_ASSIST_PATH__",
      "（这条也在标记之后）",
      ""
    ].join("\n");
    const path = readLoginShellPath({
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      run: () => output
    });
    expect(path).toBe("/opt/homebrew/bin:/Users/someone/.nvm/versions/node/v22.22.2/bin");
  });

  it("asks the login shell for the PATH with a bounded timeout", () => {
    const asked: Array<{ shell: string; script: string; timeoutMs: number }> = [];
    readLoginShellPath({
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      run: (shell, script, _env, timeoutMs) => {
        asked.push({ shell, script, timeoutMs });
        return "__MEMMY_ASSIST_PATH__/usr/bin__MEMMY_ASSIST_PATH__";
      }
    });
    expect(asked[0]?.shell).toBe("/bin/zsh");
    // 必须是登录 + 交互 shell：用户实际用的是这一份 PATH。
    expect(asked[0]?.script).toContain("$PATH");
    expect(asked[0]?.timeoutMs).toBe(LOGIN_SHELL_TIMEOUT_MS);
  });

  it("actually gives up when the shell does not answer in time", () => {
    // 用一段自己的脚本代替登录 shell：它只会睡过头，验证超时真的生效。
    const dir = workdir();
    const slow = join(dir, "slow-shell.sh");
    writeFileSync(slow, "#!/bin/sh\nsleep 30\necho __MEMMY_ASSIST_PATH__/late__MEMMY_ASSIST_PATH__\n");
    chmodSync(slow, 0o755);
    const started = Date.now();
    const path = readLoginShellPath({ shell: slow, timeoutMs: 200, env: {} as NodeJS.ProcessEnv });
    expect(path).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("falls back when the output has no markers at all", () => {
    expect(readLoginShellPath({
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      run: () => "只有提示，没有 PATH"
    })).toBeNull();
    // 只有一个标记（被截断）也不能猜。
    expect(readLoginShellPath({
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      run: () => "__MEMMY_ASSIST_PATH__/usr/bin"
    })).toBeNull();
  });

  it("does not guess when there is no login shell", () => {
    expect(readLoginShellPath({ env: {} as NodeJS.ProcessEnv, run: () => "__MEMMY_ASSIST_PATH__/usr/bin__MEMMY_ASSIST_PATH__" }))
      .toBeNull();
  });

  it("skips the whole thing on Windows", () => {
    let called = false;
    expect(readLoginShellPath({
      platform: "win32",
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      run: () => {
        called = true;
        return "__MEMMY_ASSIST_PATH__/usr/bin__MEMMY_ASSIST_PATH__";
      }
    })).toBeNull();
    expect(called).toBe(false);
  });

  it("can be switched off so unit tests never run the user's shell", () => {
    let called = false;
    expect(readLoginShellPath({
      disabled: true,
      env: { SHELL: "/bin/zsh" } as NodeJS.ProcessEnv,
      run: () => {
        called = true;
        return "__MEMMY_ASSIST_PATH__/usr/bin__MEMMY_ASSIST_PATH__";
      }
    })).toBeNull();
    expect(called).toBe(false);
  });
});

describe("assistSearchPath", () => {
  it("puts the login shell PATH first, then the process PATH, then the usual places, without duplicates", () => {
    const merged = assistSearchPath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin");
    const dirs = merged.split(":");
    expect(dirs.slice(0, 4)).toEqual(["/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/local/bin"]);
    // 去重：同一个目录只出现一次。
    expect(dirs.filter((dir) => dir === "/usr/bin")).toHaveLength(1);
    expect(dirs).toContain("/opt/homebrew/bin");
  });

  it("still works when the login shell could not be read", () => {
    const dirs = assistSearchPath("/usr/bin", null).split(":");
    expect(dirs[0]).toBe("/usr/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
  });

  it("joins with semicolons on Windows and still merges the process PATH with the usual places", () => {
    // Windows 没有登录 shell（loginPath 一直是 null），拼错分隔符会把整条 PATH 弄成一段没人认得的字符串。
    const merged = assistSearchPath("C:\\Windows;C:\\tools", null, {
      platform: "win32",
      env: {
        LOCALAPPDATA: "C:\\Users\\q sun\\AppData\\Local",
        APPDATA: "C:\\Users\\q sun\\AppData\\Roaming"
      } as NodeJS.ProcessEnv
    });
    const dirs = merged.split(";");
    expect(dirs[0]).toBe("C:\\Windows");
    expect(dirs[1]).toBe("C:\\tools");
    expect(dirs).toContain("C:\\Users\\q sun\\AppData\\Roaming\\npm");
    // 用 `:` 切的时候 `C:\Windows;C:\tools` 会是一段，分开才对。
    expect(dirs).not.toContain("C:\\Windows;C:\\tools");
    expect(merged).not.toContain("/opt/homebrew/bin");
  });

  it("does not leave macOS directories in a Windows PATH", () => {
    const dirs = assistSearchPath("", null, { platform: "win32", env: {} as NodeJS.ProcessEnv }).split(";");
    expect(dirs.every((dir) => dir !== "/usr/bin")).toBe(true);
  });
});

describe("assistEnv", () => {
  it("replaces PATH and keeps everything else", () => {
    const env = assistEnv(
      { PATH: "/usr/bin:/bin", HOME: "/Users/example", MEMMY_HOME: "/tmp/memmy" } as NodeJS.ProcessEnv,
      { env: {} as NodeJS.ProcessEnv, shell: "", run: () => null }
    );
    expect(env.HOME).toBe("/Users/example");
    expect(env.MEMMY_HOME).toBe("/tmp/memmy");
    expect((env.PATH ?? "").split(":")[0]).toBe("/usr/bin");
    expect(env.PATH).toContain("/opt/homebrew/bin");
  });

  it("gives the login shell directories priority over the process PATH", () => {
    const env = assistEnv(
      { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv,
      {
        env: {} as NodeJS.ProcessEnv,
        shell: "/bin/zsh",
        run: () => "__MEMMY_ASSIST_PATH__/Users/example/.nvm/versions/node/v22/bin__MEMMY_ASSIST_PATH__"
      }
    );
    expect((env.PATH ?? "").split(":")[0]).toBe("/Users/example/.nvm/versions/node/v22/bin");
  });

  it("does not lose the process PATH when the key is spelled `Path`", () => {
    // Windows 的环境块里写的是 `Path`：复制成普通对象后 env.PATH 读不到，只看 env.PATH 会把整条 PATH 丢掉。
    const env = assistEnv(
      { Path: "C:\\Windows", APPDATA: "C:\\Users\\q sun\\AppData\\Roaming" } as NodeJS.ProcessEnv,
      { platform: "win32", env: {} as NodeJS.ProcessEnv }
    );
    expect((env.PATH ?? "").split(";")[0]).toBe("C:\\Windows");
    // 不留第二份同名键：子进程里两个 `Path` 谁生效不由我们决定。
    expect(env.Path).toBeUndefined();
  });

  it("produces a usable PATH on Windows, where there is no login shell to read", () => {
    const env = assistEnv(
      { PATH: "C:\\Windows", APPDATA: "C:\\Users\\q sun\\AppData\\Roaming" } as NodeJS.ProcessEnv,
      { platform: "win32", env: {} as NodeJS.ProcessEnv }
    );
    const dirs = (env.PATH ?? "").split(";");
    expect(dirs[0]).toBe("C:\\Windows");
    expect(dirs).toContain("C:\\Users\\q sun\\AppData\\Roaming\\npm");
    // 其余变量原样保留。
    expect(env.APPDATA).toBe("C:\\Users\\q sun\\AppData\\Roaming");
  });
});
