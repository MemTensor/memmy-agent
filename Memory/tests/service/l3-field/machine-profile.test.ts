import { describe, expect, it } from "vitest";
import {
  machineProfileFingerprint,
  probeMachine,
  renderMachineProfile,
  type LoginShellRunner,
  type VersionRunner
} from "../../../src/service/l3-field/machine-profile.js";

const outputs: Record<string, string> = {
  node: "v25.1.0",
  python3: "Python 3.11.5",
  git: "git version 2.39.5 (Apple Git-154)",
  npm: "11.6.2"
};
const runner: VersionRunner = async (executable) => outputs[executable] ?? null;
const noShell: LoginShellRunner = async () => null;

describe("machine profile", () => {
  it("keeps only version numbers and marks tools that were not found", async () => {
    const probe = await probeMachine({ runVersion: runner, runLoginShell: noShell, env: { SHELL: "/bin/zsh" } });
    expect(probe.shell).toBe("zsh");
    expect(probe.tools).toMatchObject({ node: "25.1.0", python3: "3.11.5", git: "2.39.5", npm: "11.6.2", brew: null, pnpm: null });
    const text = renderMachineProfile(probe);
    expect(text).toContain("shell：zsh");
    expect(text).toContain("node 25.1.0，python3 3.11.5，git 2.39.5，npm 11.6.2");
    expect(text).toContain("未检测到：brew");
  });

  it("reports the macOS product version rather than the Darwin kernel version", async () => {
    const withSwVers: VersionRunner = async (executable) => (executable === "sw_vers" ? "26.1\n" : outputs[executable] ?? null);
    const probe = await probeMachine({ runVersion: withSwVers, runLoginShell: noShell, env: {}, os: "darwin" });
    expect(probe.osVersion).toBe("26.1");
    expect(renderMachineProfile(probe)).toContain("系统：macOS 26.1");
  });

  it("renders the same probe to the same text and fingerprint", async () => {
    const a = await probeMachine({ runVersion: runner, runLoginShell: noShell, env: { SHELL: "/bin/zsh" } });
    const b = await probeMachine({ runVersion: runner, runLoginShell: noShell, env: { SHELL: "/bin/zsh" } });
    expect(renderMachineProfile(a)).toBe(renderMachineProfile(b));
    expect(machineProfileFingerprint(a)).toBe(machineProfileFingerprint(b));
  });

  it("treats a failing or timed-out probe as not installed", async () => {
    const failing: VersionRunner = async () => {
      throw new Error("timeout");
    };
    const probe = await probeMachine({ runVersion: failing, runLoginShell: noShell, env: {} });
    expect(Object.values(probe.tools).every((value) => value === null)).toBe(true);
    expect(probe.shell).toBeNull();
  });

  it("prefers versions seen by the login shell and falls back to running tools directly", async () => {
    const shellOutput = [
      "Welcome banner 1.2.3 from .zshrc",
      "__memmy_probe__node", "v22.11.0",
      "__memmy_probe__python3", "Python 3.12.4",
      "__memmy_probe__conda", "conda 24.9.2",
      "__memmy_probe__java", "The operation couldn't be completed. Unable to locate a Java Runtime.",
      "__memmy_probe__go", ""
    ].join("\n");
    let script = "";
    const shell: LoginShellRunner = async (_shell, body) => {
      script = body;
      return shellOutput;
    };
    const probe = await probeMachine({ runVersion: runner, runLoginShell: shell, env: { SHELL: "/bin/zsh" }, os: "linux" });
    expect(script).toContain("command -v rustc");
    expect(probe.tools).toMatchObject({ node: "22.11.0", python3: "3.12.4", conda: "24.9.2", git: "2.39.5", java: null, go: null });
    const text = renderMachineProfile(probe);
    expect(text).toContain("node 22.11.0，python3 3.12.4，git 2.39.5，npm 11.6.2，conda 24.9.2");
    expect(text).toContain("未检测到：brew");
    expect(text).not.toContain("java");
  });

  it("does not use a login shell on Windows", async () => {
    let called = false;
    const shell: LoginShellRunner = async () => {
      called = true;
      return null;
    };
    await probeMachine({ runVersion: runner, runLoginShell: shell, env: { SHELL: "bash" }, os: "win32" });
    expect(called).toBe(false);
  });
});
